"""
app.py — ClimateOS Backend (Flask)
Deploy ke Render.com sebagai Web Service gratis.

OPTIMASI QUOTA FIRESTORE (v3 — Centralized Buffer):
- Buffer dipindah ke services/buffer.py → tidak ada lagi circular import
- Semua data telemetry dilayani dari memory → 0 Firestore reads untuk read endpoints
- Firestore hanya dipakai untuk WRITE (persist) dan bootstrap saat cold start
- /api/compliance pakai buffer untuk data hari ini → hemat Firestore reads
- Gunicorn berjalan dengan 1 worker (lihat Procfile) → buffer konsisten
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore

from services.notifier import process_alert, check_offline_sensors, ROOM_CONFIG, update_last_seen
from services.weather import get_outdoor_weather
from services.buffer import (
    bootstrap_buffer, add_to_buffer, get_buffer_since,
    get_latest, get_all_latest, get_buffer_size, should_persist,
)
from services import config as config_service
from services import alerts_log
from services import retention
from routes.ai import handle_chat
from routes.analytics import run_analytics
from routes import admin as admin_routes
from routes import verification as verification_routes

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Flask app ─────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ── Firebase / Firestore init ─────────────────────────────────
try:
    if not firebase_admin._apps:
        sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
        if sa_json:
            sa_dict = json.loads(sa_json)
            cred = credentials.Certificate(sa_dict)
            firebase_admin.initialize_app(cred)
            logger.info("Firebase initialized with service account credentials.")
        else:
            logger.warning("FIREBASE_SERVICE_ACCOUNT_JSON not set!")
            firebase_admin.initialize_app()
    db = firestore.client()
    logger.info("Firestore client ready.")
except Exception as exc:
    logger.error("Firebase initialization FAILED: %s", exc)
    db = None


# ── Helper env ────────────────────────────────────────────────
def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Environment variable '{name}' belum diset di Render Dashboard.")
    return value


# ── Serialize timestamp helper ────────────────────────────────
def _serialize_ts(ts):
    if hasattr(ts, "isoformat"):
        return ts.isoformat()
    return str(ts) if ts else None


# ── Compliance helper: proses list record menjadi result dict ─
def _process_compliance_records(records: list, room: dict, device_id: str, date_str: str) -> dict:
    """Shared logic untuk hitung compliance score dari list record."""
    total_records = len(records)
    if total_records == 0:
        return {
            "device_id": device_id, "room_name": room["name"], "date": date_str,
            "total_records": 0, "in_range_records": 0, "compliance_score": 0,
            "deviations": [], "temp_avg": 0, "temp_min": 0, "temp_max": 0, "hum_avg": 0,
        }

    in_range = 0
    deviations = []
    temps, hums = [], []
    current_dev = None

    for rec in records:
        t   = rec.get("temperature", 0)
        h   = rec.get("humidity", 0)
        ts  = rec.get("timestamp")
        temps.append(t)
        hums.append(h)

        is_safe = (room["tempMin"] <= t <= room["tempMax"]) and (room["humMin"] <= h <= room["humMax"])
        if is_safe:
            in_range += 1
            if current_dev:
                current_dev["end"] = _serialize_ts(ts)
                current_dev["duration_minutes"] = int(
                    (ts - current_dev["_start_dt"]).total_seconds() / 60
                )
                del current_dev["_start_dt"]
                if current_dev["duration_minutes"] > 0:
                    deviations.append(current_dev)
                current_dev = None
        else:
            if not current_dev:
                type_str = (
                    "TEMP_HIGH" if t > room["tempMax"] else
                    "TEMP_LOW"  if t < room["tempMin"] else
                    "HUM_HIGH"  if h > room["humMax"]  else
                    "HUM_LOW"
                )
                max_val = t if "TEMP" in type_str else h
                thresh  = (
                    room["tempMax"] if type_str == "TEMP_HIGH" else
                    room["tempMin"] if type_str == "TEMP_LOW"  else
                    room["humMax"]  if type_str == "HUM_HIGH"  else
                    room["humMin"]
                )
                current_dev = {
                    "start": _serialize_ts(ts), "_start_dt": ts,
                    "type": type_str, "max_value": max_val, "threshold": thresh,
                }
            else:
                val = t if "TEMP" in current_dev["type"] else h
                if "HIGH" in current_dev["type"] and val > current_dev["max_value"]:
                    current_dev["max_value"] = val
                elif "LOW" in current_dev["type"] and val < current_dev["max_value"]:
                    current_dev["max_value"] = val

    if current_dev:
        last_ts = records[-1].get("timestamp")
        current_dev["end"] = _serialize_ts(last_ts)
        current_dev["duration_minutes"] = int(
            (last_ts - current_dev["_start_dt"]).total_seconds() / 60
        )
        del current_dev["_start_dt"]
        if current_dev["duration_minutes"] > 0:
            deviations.append(current_dev)

    return {
        "device_id": device_id, "room_name": room["name"], "date": date_str,
        "total_records": total_records, "in_range_records": in_range,
        "compliance_score": round((in_range / total_records) * 100, 2),
        "deviations": deviations,
        "temp_avg": round(sum(temps) / len(temps), 1),
        "temp_min": round(min(temps), 1),
        "temp_max": round(max(temps), 1),
        "hum_avg":  round(sum(hums)  / len(hums),  1),
    }


# ══════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════

# ── Health check ──────────────────────────────────────────────
@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "status":      "ClimateOS backend running",
        "firebase":    "connected" if db is not None else "NOT connected",
        "buffer_size": get_buffer_size(),
        "time":        datetime.now(timezone.utc).isoformat(),
    })


# ── Ping (keep-alive) ─────────────────────────────────────────
@app.route("/ping", methods=["GET"])
def ping():
    return jsonify({"status": "alive", "time": datetime.now(timezone.utc).isoformat()})


# ── 1. Telemetry Ingestion ────────────────────────────────────
@app.route("/api/telemetry", methods=["POST"])
def telemetry():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    body      = request.get_json(silent=True) or {}
    errors    = []
    temperature = body.get("temperature")
    humidity    = body.get("humidity")
    device_id   = body.get("device_id", "esp32-default")

    if temperature is None:
        errors.append("Missing field: temperature")
    elif not isinstance(temperature, (int, float)) or not (-50 <= float(temperature) <= 100):
        errors.append("temperature harus angka antara -50 dan 100")
    if humidity is None:
        errors.append("Missing field: humidity")
    elif not isinstance(humidity, (int, float)) or not (0 <= float(humidity) <= 100):
        errors.append("humidity harus angka antara 0 dan 100")
    if errors:
        return jsonify({"error": "Validation failed", "details": errors}), 400

    temperature = round(float(temperature), 2)
    humidity    = round(float(humidity), 2)
    device_id   = str(device_id)[:64]
    now         = datetime.now(timezone.utc)

    # 0. Terapkan koreksi kalibrasi per unit (kalau ada) — SEBELUM disimpan/dievaluasi,
    #    supaya seluruh sistem (alert, buffer, compliance, analytics) selalu lihat nilai
    #    yang sudah terkoreksi. Offset diatur lewat halaman Admin, bukan di firmware.
    room_cfg = ROOM_CONFIG.get(device_id)
    if room_cfg:
        temperature = round(temperature + room_cfg.get("tempOffset", 0.0), 2)
        humidity    = round(humidity    + room_cfg.get("humOffset", 0.0), 2)
        humidity    = max(0.0, min(100.0, humidity))  # offset tidak boleh dorong keluar batas fisik 0-100%

    # 1. Tambah ke in-memory buffer — SELALU, instan, tiap POST masuk.
    #    Ini yang bikin dashboard & alert tetap terasa real-time terlepas dari
    #    seberapa sering kita benar-benar menulis ke Firestore (lihat poin 2 di bawah).
    add_to_buffer({
        "temperature": temperature,
        "humidity":    humidity,
        "device_id":   device_id,
        "timestamp":   now,
    })

    # 2. Persist ke Firestore — DI-THROTTLE per device (should_persist), bukan tiap POST.
    #    Dengan 6 device, menulis tiap kiriman akan boros kuota write Firestore.
    #    Reading yang di-skip di sini tetap "hidup" di buffer & tetap dievaluasi untuk alert.
    if should_persist(device_id):
        try:
            db.collection("telemetry").add({
                "temperature": temperature,
                "humidity":    humidity,
                "device_id":   device_id,
                "timestamp":   now,
            })
            logger.info("Telemetry persisted: %s temp=%.2f hum=%.2f", device_id, temperature, humidity)
        except Exception as exc:
            logger.error("Firestore write failed: %s", exc)
            # Non-fatal — data tetap ada di buffer, jangan gagalkan request ESP32 gara-gara ini.

    # 3. Update last-seen untuk deteksi offline
    try:
        update_last_seen(device_id)
    except Exception as exc:
        logger.warning("update_last_seen skipped: %s", exc)

    # 4. Medical Alert System (Level 1–3)
    try:
        process_alert(temperature, humidity, device_id)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)

    return jsonify({"status": "ok", "timestamp": now.isoformat()}), 201


# ── 2. Latest ─────────────────────────────────────────────────
@app.route("/api/latest", methods=["GET"])
def latest():
    """
    100% from memory — 0 Firestore reads.
    Query param opsional: ?device_id=NICU-01
    Tanpa device_id → return record paling baru dari semua device.
    """
    device_id = request.args.get("device_id") or None
    record = get_latest(device_id)
    if not record:
        msg = f"No data for device '{device_id}'" if device_id else "No data available yet"
        return jsonify({"error": msg}), 404

    return jsonify({
        "temperature": record["temperature"],
        "humidity":    record["humidity"],
        "device_id":   record["device_id"],
        "timestamp":   _serialize_ts(record["timestamp"]),
    })


# ── 3. Rooms ──────────────────────────────────────────────────
@app.route("/api/rooms", methods=["GET"])
def rooms():
    """
    Return konfigurasi semua ruangan — single source of truth dari ROOM_CONFIG.
    Frontend tidak perlu hardcode ROOM_CONFIG lagi.
    """
    return jsonify([
        {
            "id":      device_id,
            "name":    cfg["name"],
            "floor":   cfg.get("floor", ""),
            "tempMin": cfg["tempMin"],
            "tempMax": cfg["tempMax"],
            "humMin":  cfg["humMin"],
            "humMax":  cfg["humMax"],
        }
        for device_id, cfg in ROOM_CONFIG.items()
    ])


# ── 4. Sensor Status ──────────────────────────────────────────
@app.route("/api/sensor-status", methods=["GET"])
def sensor_status():
    """100% from memory — 0 Firestore reads."""
    check_offline_sensors()

    all_latest = get_all_latest()   # {device_id: record}
    now = datetime.now(timezone.utc)
    results = []

    for device_id, room in ROOM_CONFIG.items():
        record    = all_latest.get(device_id)
        last_seen = record["timestamp"] if record else None

        if not last_seen:
            status = "never"
        else:
            diff = (now - last_seen).total_seconds()
            status = "online" if diff < 300 else "warning" if diff <= 600 else "offline"

        results.append({
            "device_id":   device_id,
            "room_name":   room["name"],
            "floor":       room.get("floor", ""),
            "last_seen":   _serialize_ts(last_seen),
            "status":      status,
            "temperature": record["temperature"] if record else None,
            "humidity":    record["humidity"]    if record else None,
            "tempMin":     room["tempMin"],
            "tempMax":     room["tempMax"],
            "humMin":      room["humMin"],
            "humMax":      room["humMax"],
        })

    # Device yang ada di buffer tapi tidak terdaftar di ROOM_CONFIG
    for dev_id, record in all_latest.items():
        if dev_id not in ROOM_CONFIG:
            diff   = (now - record["timestamp"]).total_seconds()
            status = "online" if diff < 300 else "warning" if diff <= 600 else "offline"
            results.append({
                "device_id": dev_id,
                "room_name": "Unknown",
                "last_seen": _serialize_ts(record["timestamp"]),
                "status":    status,
                "unknown":   True,
            })

    return jsonify(results)


# ── 5. History ────────────────────────────────────────────────
@app.route("/api/history", methods=["GET"])
def history():
    """
    100% from memory — 0 Firestore reads.
    Query params:
      range     : live | 1h | 3h | 12h | 24h  (default: 1h)
      device_id : opsional — filter ke satu ruangan saja
    """
    range_param   = request.args.get("range", "1h")
    device_id     = request.args.get("device_id") or None
    range_minutes = {"live": 15, "1h": 60, "3h": 180, "12h": 720, "24h": 1440}.get(range_param, 60)
    cutoff        = datetime.now(timezone.utc) - timedelta(minutes=range_minutes)
    records       = get_buffer_since(cutoff)

    if device_id:
        records = [r for r in records if r.get("device_id") == device_id]

    result = [{
        "temperature": r["temperature"],
        "humidity":    r["humidity"],
        "device_id":   r["device_id"],
        "timestamp":   _serialize_ts(r["timestamp"]),
    } for r in records]

    return jsonify({"data": result, "count": len(result)})


# ── 6. Stats ──────────────────────────────────────────────────
@app.route("/api/stats", methods=["GET"])
def stats():
    """
    100% from memory — 0 Firestore reads.
    Query params:
      device_id : opsional — filter stats ke satu ruangan saja
    """
    device_id   = request.args.get("device_id") or None
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    records     = get_buffer_since(today_start)

    if device_id:
        records = [r for r in records if r.get("device_id") == device_id]

    if not records:
        return jsonify({"count": 0})

    temps  = [r["temperature"] for r in records if r.get("temperature") is not None]
    humids = [r["humidity"]    for r in records if r.get("humidity")    is not None]

    return jsonify({
        "count":        len(records),
        "temp_min":     round(min(temps),              2) if temps  else None,
        "temp_max":     round(max(temps),              2) if temps  else None,
        "temp_avg":     round(sum(temps) / len(temps), 2) if temps  else None,
        "humidity_min": round(min(humids),             2) if humids else None,
        "humidity_max": round(max(humids),             2) if humids else None,
        "humidity_avg": round(sum(humids)/len(humids), 2) if humids else None,
    })


# ── 7. Weather ────────────────────────────────────────────────
@app.route("/api/weather", methods=["GET"])
def weather():
    try:
        api_key = _require_env("OPENWEATHER_API_KEY")
        data    = get_outdoor_weather(api_key)
        return jsonify(data)
    except RuntimeError as exc:
        logger.error("Weather config error: %s", exc)
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:
        logger.error("Weather error: %s", exc)
        return jsonify({"error": str(exc)}), 500


# ── 8. AI Chat ────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
def chat():
    body         = request.get_json(silent=True) or {}
    user_message = body.get("message", "").strip()
    history      = body.get("history", [])          # [{role, text}, ...]

    if not user_message:
        return jsonify({"error": "message field wajib diisi"}), 400

    try:
        gemini_api_key = _require_env("GEMINI_API_KEY")
        reply          = handle_chat(user_message, gemini_api_key, history)
        return jsonify({"reply": reply})
    except RuntimeError as exc:
        logger.error("Chat config error: %s", exc)
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:
        logger.error("Chat error: %s", exc)
        return jsonify({"error": "AI tidak tersedia, coba lagi."}), 500


# ── 9. Compliance ─────────────────────────────────────────────
@app.route("/api/compliance", methods=["GET"])
def compliance():
    """
    Laporan compliance harian per ruangan.
    - Hari ini → pakai in-memory buffer (0 Firestore reads)
    - Hari sebelumnya → query Firestore
    """
    device_id = request.args.get("device_id", "NICU-01")
    date_str  = request.args.get("date")

    room = ROOM_CONFIG.get(device_id)
    if not room:
        return jsonify({"error": "Unknown room"}), 404
    if not date_str:
        return jsonify({"error": "Missing date parameter"}), 400

    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return jsonify({"error": "Invalid date format, gunakan YYYY-MM-DD"}), 400

    start_of_day = dt
    end_of_day   = dt + timedelta(days=1)
    today_start  = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    # Pakai buffer untuk data hari ini
    if dt == today_start:
        raw_records = [
            r for r in get_buffer_since(start_of_day)
            if r.get("device_id") == device_id and r["timestamp"] < end_of_day
        ]
        return jsonify(_process_compliance_records(raw_records, room, device_id, date_str))

    # Query Firestore untuk data historis
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    try:
        query = (
            db.collection("telemetry")
            .where("device_id", "==", device_id)
            .where("timestamp", ">=", start_of_day)
            .where("timestamp", "<",  end_of_day)
            .order_by("timestamp", direction=firestore.Query.ASCENDING)
        )
        docs = list(query.stream())
        raw_records = [{"temperature": d.to_dict().get("temperature", 0),
                        "humidity":    d.to_dict().get("humidity", 0),
                        "timestamp":   d.to_dict().get("timestamp")}
                       for d in docs]
        return jsonify(_process_compliance_records(raw_records, room, device_id, date_str))
    except Exception as exc:
        logger.error("Compliance Firestore query failed: %s", exc)
        return jsonify({"error": f"Query failed: {exc}"}), 500


# ── 10. ML Analytics ──────────────────────────────────────────
@app.route("/api/analytics", methods=["GET"])
def analytics():
    """
    Jalankan analisis ML (Linear Regression, Z-Score, K-Means, SHAP) pada data historis.
    Query params:
      device_id : opsional — filter ke satu ruangan (kosong = semua ruangan)
      range     : 1 | 3 | 7 | 30  (hari, default: 7)
    """
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    device_id = request.args.get("device_id") or None
    try:
        range_days = int(request.args.get("range", 7))
        if range_days not in (1, 3, 7, 30):
            range_days = 7
    except (ValueError, TypeError):
        range_days = 7

    try:
        result = run_analytics(db, device_id, range_days)
        if "error" in result:
            return jsonify(result), 422
        return jsonify(result)
    except Exception as exc:
        logger.error("Analytics error: %s", exc)
        return jsonify({"error": f"Analisis gagal: {exc}"}), 500


# ── 11. History rentang tanggal bebas (akreditasi) ─────────────
@app.route("/api/history-range", methods=["GET"])
def history_range():
    """
    Ambil data historis untuk rentang tanggal bebas, langsung dari Firestore
    (bukan buffer 24 jam) — dipakai halaman History untuk kebutuhan akreditasi
    (mis. tarik data 1 bulan). Query params:
      device_id : wajib
      start     : YYYY-MM-DD (wajib)
      end       : YYYY-MM-DD (wajib, eksklusif — data sampai sebelum tanggal ini)
    """
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    device_id = request.args.get("device_id")
    start_str = request.args.get("start")
    end_str   = request.args.get("end")

    if not device_id or device_id not in ROOM_CONFIG:
        return jsonify({"error": "device_id wajib diisi dan harus ruangan terdaftar"}), 400
    if not start_str or not end_str:
        return jsonify({"error": "Parameter start dan end (YYYY-MM-DD) wajib diisi"}), 400

    try:
        start_dt = datetime.strptime(start_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_dt   = datetime.strptime(end_str, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
    except ValueError:
        return jsonify({"error": "Format tanggal harus YYYY-MM-DD"}), 400

    if (end_dt - start_dt).days > 62:
        return jsonify({"error": "Rentang maksimum 60 hari per permintaan"}), 400

    try:
        query = (
            db.collection("telemetry")
            .where("device_id", "==", device_id)
            .where("timestamp", ">=", start_dt)
            .where("timestamp", "<", end_dt)
            .order_by("timestamp", direction=firestore.Query.ASCENDING)
        )
        docs = list(query.stream())
        result = [{
            "temperature": d.to_dict().get("temperature"),
            "humidity":    d.to_dict().get("humidity"),
            "device_id":   d.to_dict().get("device_id"),
            "timestamp":   _serialize_ts(d.to_dict().get("timestamp")),
        } for d in docs]
        return jsonify({"data": result, "count": len(result)})
    except Exception as exc:
        logger.error("History-range query failed: %s", exc)
        return jsonify({"error": f"Query gagal: {exc}"}), 500


# ── 12. Admin — threshold ruangan ───────────────────────────────
@app.route("/api/admin/rooms/<device_id>", methods=["PUT"])
def admin_update_room(device_id):
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    updates = body.get("updates") or {k: v for k, v in body.items() if k != "changed_by"}
    changed_by = body.get("changed_by", "unknown")
    try:
        updated = admin_routes.update_room(db, device_id, updates, changed_by)
        return jsonify(updated)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("admin_update_room error: %s", exc)
        return jsonify({"error": f"Gagal update: {exc}"}), 500


# ── 13. Admin/Public — daftar verifikator ───────────────────────
@app.route("/api/verifikators", methods=["GET"])
def list_verifikators():
    return jsonify(admin_routes.list_verifikators())


@app.route("/api/admin/verifikators", methods=["POST"])
def admin_add_verifikator():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        entry = admin_routes.create_verifikator(db, body.get("name", ""), body.get("added_by", "unknown"))
        return jsonify(entry), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("admin_add_verifikator error: %s", exc)
        return jsonify({"error": f"Gagal tambah verifikator: {exc}"}), 500


@app.route("/api/admin/verifikators/<verifikator_id>", methods=["DELETE"])
def admin_delete_verifikator(verifikator_id):
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        admin_routes.delete_verifikator(db, verifikator_id, body.get("removed_by", "unknown"))
        return jsonify({"status": "ok"})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        logger.error("admin_delete_verifikator error: %s", exc)
        return jsonify({"error": f"Gagal hapus verifikator: {exc}"}), 500


# ── 14. Admin — audit log ───────────────────────────────────────
@app.route("/api/admin/audit-log", methods=["GET"])
def admin_audit_log():
    limit = request.args.get("limit", 50, type=int)
    return jsonify(admin_routes.get_audit_log(db, limit))


# ── 15. Verifikasi shift (tanda tangan digital) ─────────────────
@app.route("/api/verifications", methods=["POST"])
def submit_verification():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        result = verification_routes.submit_verification(
            db,
            device_id=body.get("device_id"),
            shift=body.get("shift"),
            verifikator_id=body.get("verifikator_id"),
            temperature=body.get("temperature"),
            humidity=body.get("humidity"),
            signature=body.get("signature"),
            catatan=body.get("catatan", ""),
            tindakan=body.get("tindakan", ""),
        )
        return jsonify(result), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("submit_verification error: %s", exc)
        return jsonify({"error": f"Gagal simpan verifikasi: {exc}"}), 500


@app.route("/api/verifications", methods=["GET"])
def list_verifications():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    device_id = request.args.get("device_id")
    try:
        year  = request.args.get("year", type=int)
        month = request.args.get("month", type=int)
    except Exception:
        year = month = None
    if not device_id or not year or not month:
        return jsonify({"error": "device_id, year, month wajib diisi"}), 400
    try:
        results = verification_routes.get_verifications(db, device_id, year, month)
        return jsonify({"data": results, "count": len(results)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("list_verifications error: %s", exc)
        return jsonify({"error": f"Gagal ambil data: {exc}"}), 500


# ── 16. Alerts — notification bell website ──────────────────────
@app.route("/api/alerts", methods=["GET"])
def recent_alerts():
    """100% dari memory (alerts_log) — dipakai bell notifikasi di dashboard."""
    limit = request.args.get("limit", 20, type=int)
    return jsonify(alerts_log.get_recent_alerts(limit))


# ── Bootstrap & Run ───────────────────────────────────────────
config_service.load_config(db)
bootstrap_buffer(db)
alerts_log.bootstrap_alerts(db)
retention.start_scheduler(db)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
