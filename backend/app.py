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
from services.timeutil import today_start_utc, parse_date_wib, dalam_jendela_shift
from services.auth import (
    require_device_key, require_user, actor_email, status_kunci_perangkat,
)
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
@require_device_key
def telemetry():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    body      = request.get_json(silent=True) or {}
    errors    = []
    temperature = body.get("temperature")
    humidity    = body.get("humidity")
    device_id   = body.get("device_id", "esp32-default")

    # Batas kewajaran fisik ruangan rumah sakit. Ini JARING TERAKHIR — penyaringan
    # utama ada di firmware (masa pemanasan, median 5 sampel, guard lonjakan).
    #
    # Batas lama -50..100 °C terlalu longgar untuk tujuannya: nilai sampah khas
    # DHT22 saat baru menyala, misalnya 1,2 °C, tetap lolos dan masuk database —
    # lalu ikut tercetak di laporan akreditasi dan memicu alarm palsu.
    # Diperketat supaya unit yang firmware-nya belum diperbarui pun tetap tersaring.
    # Batasnya SAMA PERSIS dengan PHYS_* di firmware. Percobaan pertama memakai
    # 0-60 °C dengan maksud "sedikit lebih longgar sebagai jaring", tapi itu justru
    # meloloskan 1,2 °C — nilai sampah yang persis mau dicegah. Jaring yang
    # bolong tepat di lubang yang mau ditambal tidak ada gunanya.
    if temperature is None:
        errors.append("Missing field: temperature")
    elif not isinstance(temperature, (int, float)) or not (5 <= float(temperature) <= 50):
        errors.append("temperature di luar batas kewajaran ruangan (5-50 °C)")
    if humidity is None:
        errors.append("Missing field: humidity")
    elif not isinstance(humidity, (int, float)) or not (10 <= float(humidity) <= 99):
        errors.append("humidity di luar batas kewajaran ruangan (10-99%)")
    if errors:
        # Dicatat, bukan ditolak diam-diam. Perangkat yang sering ditolak berarti
        # sensornya mulai rusak — itu informasi yang dibutuhkan teknisi.
        logger.warning("Telemetri ditolak dari %s: %s (temperature=%r humidity=%r)",
                       body.get("device_id", "?"), "; ".join(errors), temperature, humidity)
        return jsonify({"error": "Validation failed", "details": errors}), 400

    temperature = round(float(temperature), 2)
    humidity    = round(float(humidity), 2)
    device_id   = str(device_id)[:64]
    now         = datetime.now(timezone.utc)

    # Versi firmware yang dilaporkan alat — dipakai untuk tahu unit mana yang
    # belum diperbarui, dan untuk memutuskan apakah perlu dikirimi perintah OTA.
    fw_version = str(body.get("fw_version", ""))[:16]

    # Baterai — opsional, hanya dikirim unit yang punya modul voltage sensor.
    # Ditolak diam-diam kalau di luar akal (pack 2S 18650: 6,0-8,4 V) supaya
    # pembacaan ADC yang kacau tidak muncul sebagai "baterai 300%" di dashboard.
    batt_v = body.get("battery_v")
    batt_p = body.get("battery_pct")
    try:
        batt_v = round(float(batt_v), 2) if batt_v is not None and 3.0 <= float(batt_v) <= 13.0 else None
    except (TypeError, ValueError):
        batt_v = None
    try:
        batt_p = int(batt_p) if batt_p is not None and 0 <= int(batt_p) <= 100 else None
    except (TypeError, ValueError):
        batt_p = None

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
        "battery_v":   batt_v,
        "battery_pct": batt_p,
        "fw_version":  fw_version or None,
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

    # 3b. Pemicu retensi oportunistik. Endpoint ini yang paling sering dipanggil
    #     (6 ESP32 x tiap menit), jadi paling andal untuk memastikan cleanup
    #     benar-benar jalan meski container Render sering tidur. Sangat murah:
    #     kalau belum waktunya, hanya satu perbandingan datetime.
    try:
        retention.maybe_run_cleanup(db)
    except Exception as exc:
        logger.warning("maybe_run_cleanup skipped: %s", exc)

    # 4. Medical Alert System (Level 1–3)
    try:
        process_alert(temperature, humidity, device_id)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)

    # 5. Balas dengan batas ruangan yang berlaku SEKARANG.
    #
    #    Firmware memakai ini untuk menentukan status di LCD (NORMAL/WASPADA/
    #    BAHAYA). Sebelumnya ambang itu di-hardcode di firmware, dan nilainya
    #    ternyata untuk penyimpanan dingin — ruangan 22 °C yang sehat tampil
    #    "BAHAYA!!!" di layar. Perawat akan berhenti mempercayai layarnya.
    #
    #    Dikirim menumpang respons POST yang sudah ada, BUKAN endpoint terpisah:
    #    tidak menambah request, tidak menambah waktu radio WiFi menyala, dan
    #    otomatis ikut berubah begitu admin menyetel ulang batas dari dashboard.
    resp = {"status": "ok", "timestamp": now.isoformat()}

    # Apakah lampu latar LCD perlu menyala? Dihitung di server karena ESP32 tidak
    # punya jam yang bertahan setelah mati, dan menambah sinkronisasi NTP berarti
    # menyalakan radio WiFi lebih lama — menambah pemakaian baterai yang justru
    # sedang dihemat. Firmware tinggal menurut.
    resp["lcd_on"] = dalam_jendela_shift()

    # 6. Pembaruan firmware jarak jauh (OTA).
    #
    #    Server hanya MENGUMUMKAN versi terbaru dan alamat berkasnya; keputusan
    #    memperbarui ada di alat, karena hanya alat yang tahu sisa baterai dan
    #    kekuatan sinyalnya sendiri.
    #
    #    Berkas .bin TIDAK dilayani dari sini, melainkan dari Firebase Hosting.
    #    Alasannya penting: melayani berkas ~1 MB dari Render akan memakan
    #    bandwidth dan menahan proses selama unduhan — padahal Render free tier
    #    dibatasi jam hidup. Firebase Hosting memang dirancang untuk berkas statis
    #    dan kuotanya jauh lebih longgar (10 GB/bulan; 6 alat x 1 MB per rilis
    #    tidak sampai 0,1%).
    fw_terbaru = os.environ.get("FIRMWARE_VERSION", "").strip()
    fw_url     = os.environ.get("FIRMWARE_URL", "").strip()
    if fw_terbaru and fw_url:
        resp["fw_latest"] = fw_terbaru
        resp["fw_url"]    = fw_url

    if room_cfg:
        resp["limits"] = {
            "tempMin": room_cfg["tempMin"], "tempMax": room_cfg["tempMax"],
            "humMin":  room_cfg["humMin"],  "humMax":  room_cfg["humMax"],
            "name":    room_cfg.get("name", device_id),
        }
    return jsonify(resp), 201


# ── 2. Latest ─────────────────────────────────────────────────
@app.route("/api/latest", methods=["GET"])
def latest():
    """
    100% from memory — 0 Firestore reads.
    Query param opsional: ?device_id=BERSALIN-01
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
            # Offset kalibrasi WAJIB ikut dikirim. Halaman Admin mengisi kolom
            # "Kal. Suhu"/"Kal. Hum" dari response ini; kalau tidak dikirim, kolom
            # tampil 0 dan begitu tombol Simpan diklik nilai kalibrasi asli
            # tertimpa jadi 0 (data loss).
            "tempOffset": cfg.get("tempOffset", 0.0),
            "humOffset":  cfg.get("humOffset", 0.0),
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
            # Baterai — None untuk unit yang tidak punya modul voltage sensor.
            "battery_v":   record.get("battery_v")   if record else None,
            "battery_pct": record.get("battery_pct") if record else None,
            # Versi firmware yang sedang berjalan di alat ini.
            "fw_version":  record.get("fw_version")  if record else None,
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
    # "Hari ini" menurut WIB, bukan UTC. Dengan UTC, statistik harian baru mulai
    # dihitung pukul 07:00 pagi waktu setempat — perawat shift Pagi akan melihat
    # "Terendah hari ini" kosong padahal sensor sudah berjalan semalaman.
    today_start = today_start_utc()
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
    # Default ke ruangan pertama yang terdaftar, bukan ID lama "NICU-01" yang
    # sudah tidak ada sejak migrasi ke 6 ruangan RSND.
    _default_room = next(iter(ROOM_CONFIG), "")
    device_id = request.args.get("device_id") or _default_room
    date_str  = request.args.get("date")

    room = ROOM_CONFIG.get(device_id)
    if not room:
        return jsonify({"error": "Unknown room"}), 404
    if not date_str:
        return jsonify({"error": "Missing date parameter"}), 400

    # Tanggal ditafsirkan sebagai tanggal WIB. Kalau dibaca sebagai UTC, laporan
    # "tanggal 5" sebenarnya berisi 5 Agt 07:00 s/d 6 Agt 07:00 waktu setempat —
    # shift Malam tanggal 5 (22:00 WIB) bocor ke laporan tanggal 6.
    try:
        start_of_day, end_of_day = parse_date_wib(date_str)
    except ValueError:
        return jsonify({"error": "Invalid date format, gunakan YYYY-MM-DD"}), 400

    today_start = today_start_utc()

    # Pakai buffer untuk data hari ini
    if start_of_day == today_start:
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

    # Tanggal mulai & selesai ditafsirkan sebagai tanggal WIB (inklusif keduanya):
    # start = 00:00 WIB tanggal mulai, end = 00:00 WIB sehari setelah tanggal selesai.
    try:
        start_dt, _ = parse_date_wib(start_str)
        _, end_dt   = parse_date_wib(end_str)
    except ValueError:
        return jsonify({"error": "Format tanggal harus YYYY-MM-DD"}), 400
    if end_dt <= start_dt:
        return jsonify({"error": "Tanggal selesai harus sama atau setelah tanggal mulai"}), 400

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
@require_user
def admin_update_room(device_id):
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    updates = body.get("updates") or {k: v for k, v in body.items() if k != "changed_by"}
    # Identitas diambil dari token yang sudah diverifikasi. Nilai 'changed_by'
    # kiriman frontend hanya dipakai kalau autentikasi belum diberlakukan —
    # kalau tidak, siapa pun bisa mengaku sebagai orang lain di audit log.
    changed_by = actor_email(body.get("changed_by", "unknown"))
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
@require_user
def admin_add_verifikator():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        entry = admin_routes.create_verifikator(db, body.get("name", ""), actor_email(body.get("added_by", "unknown")))
        return jsonify(entry), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("admin_add_verifikator error: %s", exc)
        return jsonify({"error": f"Gagal tambah verifikator: {exc}"}), 500


@app.route("/api/admin/verifikators/<verifikator_id>", methods=["DELETE"])
@require_user
def admin_delete_verifikator(verifikator_id):
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        admin_routes.delete_verifikator(db, verifikator_id, actor_email(body.get("removed_by", "unknown")))
        return jsonify({"status": "ok"})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        logger.error("admin_delete_verifikator error: %s", exc)
        return jsonify({"error": f"Gagal hapus verifikator: {exc}"}), 500


# ── 14. Admin — audit log ───────────────────────────────────────
@app.route("/api/admin/audit-log", methods=["GET"])
@require_user
def admin_audit_log():
    limit = request.args.get("limit", 50, type=int)
    return jsonify(admin_routes.get_audit_log(db, limit))


# ── 15. Verifikasi shift (tanda tangan digital) ─────────────────
@app.route("/api/verifications", methods=["POST"])
@require_user
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
            submitted_by=actor_email(""),
            allow_extreme=bool(body.get("allow_extreme", False)),
            sumber_nilai=body.get("sumber_nilai", "manual"),
        )
        return jsonify(result), 201
    except verification_routes.DuplicateShiftError as exc:
        # 409 Conflict, bukan 400 — frontend memakai kode ini untuk menawarkan
        # "buka ralat entri yang sudah ada" alih-alih sekadar menampilkan error.
        return jsonify({
            "error":       str(exc),
            "reason":      "duplicate_shift",
            "existing_id": exc.existing_id,
        }), 409
    except verification_routes.ImplausibleValueError as exc:
        # 422 — nilainya bisa saja benar, tapi perlu ditegaskan dulu oleh petugas.
        # Frontend menampilkan konfirmasi lalu mengirim ulang dengan allow_extreme.
        return jsonify({
            "error":  str(exc),
            "reason": "implausible_value",
        }), 422
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("submit_verification error: %s", exc)
        return jsonify({"error": f"Gagal simpan verifikasi: {exc}"}), 500


@app.route("/api/reading-now", methods=["GET"])
@require_user
def reading_now():
    """
    Pembacaan sensor terkini satu ruangan, khusus untuk mengisi form verifikasi.

    Berbeda dari /api/latest yang sekadar memberi angka: endpoint ini juga menilai
    KELAYAKAN angka itu untuk dipakai sebagai catatan resmi. Form verifikasi tidak
    boleh terisi diam-diam dengan angka basi — kalau sensor sudah lama tidak
    mengirim, yang terisi bukan keadaan ruangan sekarang, dan catatannya jadi
    tidak benar.
    """
    device_id = request.args.get("device_id")
    if not device_id or device_id not in ROOM_CONFIG:
        return jsonify({"error": "device_id wajib diisi dan harus ruangan terdaftar"}), 400

    record = get_latest(device_id)
    if not record:
        return jsonify({
            "status":  "never",
            "usable":  False,
            "message": "Sensor ruangan ini belum pernah mengirim data.",
        })

    umur = (datetime.now(timezone.utc) - record["timestamp"]).total_seconds()

    # Ambang kelayakan. 15 menit dipilih karena sensor mengirim tiap 1 menit —
    # kalau sudah 15 kali lewat tanpa kabar, jelas ada yang tidak beres.
    if umur > 900:
        status, usable = "offline", False
        message = (f"Data terakhir {int(umur // 60)} menit lalu — sensor kemungkinan mati. "
                   f"Isi suhu dan kelembapan secara manual dari alat ukur.")
    elif umur > 300:
        status, usable = "stale", True
        message = f"Data terakhir {int(umur // 60)} menit lalu. Periksa apakah masih sesuai keadaan ruangan."
    else:
        status, usable = "online", True
        message = ""

    return jsonify({
        "status":      status,
        "usable":      usable,
        "message":     message,
        "temperature": record["temperature"],
        "humidity":    record["humidity"],
        "timestamp":   _serialize_ts(record["timestamp"]),
        "age_seconds": int(umur),
    })


@app.route("/api/verifications/<verification_id>/correct", methods=["PATCH"])
@require_user
def correct_verification(verification_id):
    """
    Ralat entri verifikasi yang salah input. Nilai lama TIDAK dihapus — disimpan
    di field original_* dan entri ditandai corrected=True, meniru praktik coret-
    dan-paraf pada formulir kertas supaya tetap sah sebagai bukti akreditasi.
    """
    if db is None:
        return jsonify({"error": "Database not connected."}), 503
    body = request.get_json(silent=True) or {}
    try:
        result = verification_routes.correct_verification(
            db,
            verification_id=verification_id,
            temperature=body.get("temperature"),
            humidity=body.get("humidity"),
            alasan=body.get("alasan", ""),
            corrected_by=actor_email(body.get("corrected_by", "unknown")),
            verifikator_id=body.get("verifikator_id", ""),
            signature=body.get("signature", ""),
        )
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error("correct_verification error: %s", exc)
        return jsonify({"error": f"Gagal koreksi: {exc}"}), 500


@app.route("/api/verifications", methods=["GET"])
@require_user
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


# ── 17. Retensi — status & pemicu manual/cron eksternal ─────────
@app.route("/api/admin/firmware", methods=["GET"])
@require_user
def firmware_status():
    """
    Versi firmware yang diumumkan server vs yang benar-benar berjalan di tiap alat.
    Dipakai halaman Setting untuk melihat unit mana yang belum selesai diperbarui.
    """
    terbaru = os.environ.get("FIRMWARE_VERSION", "").strip()
    semua = get_all_latest()
    kunci = status_kunci_perangkat()
    unit = []
    belum_siap = []
    for device_id, cfg in ROOM_CONFIG.items():
        rec = semua.get(device_id) or {}
        versi = rec.get("fw_version")
        k = kunci.get(device_id)
        # None = alat ini belum pernah mengirim sejak server terakhir menyala,
        # jadi statusnya belum diketahui — berbeda dari "sudah dipastikan salah".
        kunci_ok = None if k is None else bool(k["ok"])
        if kunci_ok is False:
            belum_siap.append(device_id)
        unit.append({
            "device_id":  device_id,
            "room_name":  cfg.get("name", device_id),
            "fw_version": versi,
            # None kalau alat belum pernah melapor versi (firmware lama), supaya
            # tidak keliru ditampilkan sebagai "sudah terbaru".
            "up_to_date": (versi == terbaru) if (versi and terbaru) else None,
            "key_ok":     kunci_ok,
        })
    return jsonify({
        "latest":     terbaru or None,
        "url":        os.environ.get("FIRMWARE_URL", "").strip() or None,
        "configured": bool(terbaru and os.environ.get("FIRMWARE_URL", "").strip()),
        "devices":    unit,
        # Dipakai halaman Setting untuk memperingatkan sebelum AUTH_ENFORCE
        # dinyalakan. Alat yang ada di daftar ini akan langsung ditolak 401.
        "auth_enforced":  os.environ.get("AUTH_ENFORCE", "").strip().lower() in ("1", "true", "yes"),
        "kunci_bermasalah": belum_siap,
    })


@app.route("/api/admin/retention", methods=["GET"])
def retention_status():
    """Kapan cleanup terakhir jalan — supaya tidak perlu menebak apakah retensi hidup."""
    return jsonify(retention.get_status())


@app.route("/api/admin/run-retention", methods=["POST"])
def run_retention():
    """
    Pemicu cleanup dari luar. Dipakai kalau ingin waktu pembersihan yang pasti,
    mis. cron-job.org memanggil endpoint ini sekali sehari. Dilindungi token
    terpisah (CRON_SECRET) supaya tidak bisa dipanggil sembarang orang untuk
    membebani Firestore.

    Kirim header:  X-Cron-Secret: <nilai CRON_SECRET>
    """
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    expected = os.environ.get("CRON_SECRET", "").strip()
    if not expected:
        return jsonify({"error": "CRON_SECRET belum diset di server."}), 503
    if request.headers.get("X-Cron-Secret", "") != expected:
        return jsonify({"error": "Unauthorized"}), 401

    deleted = retention.cleanup_old_telemetry(db)
    return jsonify({"status": "ok", "deleted": deleted, **retention.get_status()})


# ── Bootstrap & Run ───────────────────────────────────────────
config_service.load_config(db)
bootstrap_buffer(db)
alerts_log.bootstrap_alerts(db)
retention.start_scheduler(db)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
