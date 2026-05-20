import sys

with open('backend/app.py', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Import check_offline_sensors
code = code.replace(
    'from services.notifier import process_alert',
    'from services.notifier import process_alert, check_offline_sensors, ROOM_CONFIG'
)

# 2. Update telemetry to remove webhook_url from process_alert
old_alert_block = '''    # 3. Discord alert (best-effort)
    try:
        webhook_url = _require_env("DISCORD_WEBHOOK_URL")
        process_alert(temperature, humidity, device_id, webhook_url)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)'''

new_alert_block = '''    # 3. Medical Alert System (Level 1-3)
    try:
        process_alert(temperature, humidity, device_id)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)'''

code = code.replace(old_alert_block, new_alert_block)

# 3. Add new endpoints before history
new_endpoints = '''
# ── NEW: Sensor Status ────────────────────────────────────────
@app.route("/api/sensor-status", methods=["GET"])
def sensor_status():
    check_offline_sensors()
    
    with _buffer_lock:
        device_last_seen = {}
        for r in _telemetry_buffer:
            device_last_seen[r["device_id"]] = r["timestamp"]

    results = []
    now = datetime.now(timezone.utc)
    for device_id, room in ROOM_CONFIG.items():
        last_seen = device_last_seen.get(device_id)
        if not last_seen:
            status = "never"
        else:
            diff = (now - last_seen).total_seconds()
            if diff < 300:
                status = "online"
            elif diff <= 600:
                status = "warning"
            else:
                status = "offline"
                
        results.append({
            "device_id": device_id,
            "room_name": room["name"],
            "last_seen": _serialize_ts(last_seen),
            "status": status
        })
    
    # Also include unknown devices that are in buffer but flag them
    for dev_id, last_seen in device_last_seen.items():
        if dev_id not in ROOM_CONFIG:
            diff = (now - last_seen).total_seconds()
            status = "online" if diff < 300 else "warning" if diff <= 600 else "offline"
            results.append({
                "device_id": dev_id,
                "room_name": "Unknown",
                "last_seen": _serialize_ts(last_seen),
                "status": status,
                "unknown": True
            })
            
    return jsonify(results)

# ── NEW: Compliance ───────────────────────────────────────────
@app.route("/api/compliance", methods=["GET"])
def compliance():
    device_id = request.args.get("device_id", "NICU-01")
    date_str = request.args.get("date")
    
    room = ROOM_CONFIG.get(device_id)
    if not room:
        return jsonify({"error": "Unknown room"}), 404
        
    if not date_str:
        return jsonify({"error": "Missing date parameter"}), 400
        
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except:
        return jsonify({"error": "Invalid date format"}), 400
        
    start_of_day = dt
    end_of_day = dt + timedelta(days=1)
    
    query = (
        db.collection("telemetry")
        .where("device_id", "==", device_id)
        .where("timestamp", ">=", start_of_day)
        .where("timestamp", "<", end_of_day)
        .order_by("timestamp", direction=firestore.Query.ASCENDING)
    )
    docs = list(query.stream())
    
    total_records = len(docs)
    if total_records == 0:
        return jsonify({
            "device_id": device_id, "room_name": room["name"], "date": date_str,
            "total_records": 0, "in_range_records": 0, "compliance_score": 0,
            "deviations": [], "temp_avg": 0, "temp_min": 0, "temp_max": 0, "hum_avg": 0
        })
        
    in_range = 0
    deviations = []
    temps = []
    hums = []
    current_dev = None
    
    for doc in docs:
        d = doc.to_dict()
        t = d.get("temperature", 0)
        h = d.get("humidity", 0)
        ts = d.get("timestamp")
        
        temps.append(t)
        hums.append(h)
        
        is_safe = (room["tempMin"] <= t <= room["tempMax"]) and (room["humMin"] <= h <= room["humMax"])
        if is_safe:
            in_range += 1
            if current_dev:
                current_dev["end"] = _serialize_ts(ts)
                current_dev["duration_minutes"] = int((ts - current_dev["_start_dt"]).total_seconds() / 60)
                del current_dev["_start_dt"]
                if current_dev["duration_minutes"] > 0:
                    deviations.append(current_dev)
                current_dev = None
        else:
            if not current_dev:
                type_str = "TEMP_HIGH" if t > room["tempMax"] else "TEMP_LOW" if t < room["tempMin"] else "HUM_HIGH" if h > room["humMax"] else "HUM_LOW"
                max_val = t if "TEMP" in type_str else h
                thresh = room["tempMax"] if type_str == "TEMP_HIGH" else room["tempMin"] if type_str == "TEMP_LOW" else room["humMax"] if type_str == "HUM_HIGH" else room["humMin"]
                
                current_dev = {
                    "start": _serialize_ts(ts), "_start_dt": ts, "type": type_str,
                    "max_value": max_val, "threshold": thresh
                }
            else:
                val = t if "TEMP" in current_dev["type"] else h
                if "HIGH" in current_dev["type"] and val > current_dev["max_value"]:
                    current_dev["max_value"] = val
                elif "LOW" in current_dev["type"] and val < current_dev["max_value"]:
                    current_dev["max_value"] = val

    if current_dev:
        ts = docs[-1].to_dict().get("timestamp")
        current_dev["end"] = _serialize_ts(ts)
        current_dev["duration_minutes"] = int((ts - current_dev["_start_dt"]).total_seconds() / 60)
        del current_dev["_start_dt"]
        if current_dev["duration_minutes"] > 0:
            deviations.append(current_dev)

    return jsonify({
        "device_id": device_id, "room_name": room["name"], "date": date_str,
        "total_records": total_records, "in_range_records": in_range,
        "compliance_score": round((in_range / total_records) * 100, 2),
        "deviations": deviations,
        "temp_avg": round(sum(temps)/len(temps), 1),
        "temp_min": round(min(temps), 1),
        "temp_max": round(max(temps), 1),
        "hum_avg": round(sum(hums)/len(hums), 1)
    })

# ── NEW: Ping ─────────────────────────────────────────────────
@app.route("/ping", methods=["GET"])
def ping():
    return jsonify({"status": "alive", "time": datetime.now(timezone.utc).isoformat(), "uptime": "ok"})

'''

code = code.replace('# ── 2. History ────────────────────────────────────────────────', new_endpoints + '\n# ── 2. History ────────────────────────────────────────────────')

with open('backend/app.py', 'w', encoding='utf-8') as f:
    f.write(code)

print("backend/app.py patched!")
