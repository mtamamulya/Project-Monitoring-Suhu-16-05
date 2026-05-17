"""
app.py — ClimateOS Backend (Flask)
Deploy ke Render.com sebagai Web Service gratis.

OPTIMASI QUOTA FIRESTORE (v2 — In-Memory Buffer):
- Semua data telemetry disimpan di memory (ring buffer 24 jam)
- Endpoint history/stats/latest dilayani 100% dari memory → 0 Firestore reads
- Firestore hanya dipakai untuk WRITE (persist) dan bootstrap saat cold start
- Estimasi usage: ~6,000 reads/hari (hanya bootstrap + weather + AI)
"""

import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore

from services.notifier import process_alert
from services.weather import get_outdoor_weather
from routes.ai import handle_chat

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Flask app ─────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)  # Izinkan request dari frontend manapun

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


# ══════════════════════════════════════════════════════════════
#  IN-MEMORY TELEMETRY BUFFER
#  Menyimpan data di RAM → endpoint read GRATIS (0 Firestore reads)
# ══════════════════════════════════════════════════════════════
_buffer_lock = threading.Lock()
_telemetry_buffer = []       # List of dicts, sorted by timestamp ASC
MAX_BUFFER_SIZE = 5760       # 24 jam @ 15 detik interval
_buffer_bootstrapped = False


def _bootstrap_buffer():
    """Load last 24h of data from Firestore into memory (one-time on cold start)."""
    global _buffer_bootstrapped
    if _buffer_bootstrapped or db is None:
        return

    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        query = (
            db.collection("telemetry")
            .where("timestamp", ">=", cutoff)
            .order_by("timestamp", direction=firestore.Query.ASCENDING)
            .limit(MAX_BUFFER_SIZE)
        )
        docs = list(query.stream())
        with _buffer_lock:
            for doc in docs:
                d = doc.to_dict()
                ts = d.get("timestamp")
                _telemetry_buffer.append({
                    "temperature": d.get("temperature"),
                    "humidity": d.get("humidity"),
                    "device_id": d.get("device_id"),
                    "timestamp": ts,
                })
        _buffer_bootstrapped = True
        logger.info("Buffer bootstrapped with %d records from Firestore.", len(docs))
    except Exception as exc:
        logger.error("Buffer bootstrap failed: %s", exc)
        _buffer_bootstrapped = True  # Don't retry forever


def _add_to_buffer(record: dict):
    """Add a new telemetry record to the in-memory buffer."""
    with _buffer_lock:
        _telemetry_buffer.append(record)
        # Trim to max size
        while len(_telemetry_buffer) > MAX_BUFFER_SIZE:
            _telemetry_buffer.pop(0)


def _get_buffer_since(cutoff_dt) -> list:
    """Get records from buffer since cutoff datetime."""
    with _buffer_lock:
        return [
            r for r in _telemetry_buffer
            if r.get("timestamp") and r["timestamp"] >= cutoff_dt
        ]


def _get_latest_from_buffer() -> dict | None:
    """Get the most recent record from buffer."""
    with _buffer_lock:
        if _telemetry_buffer:
            return _telemetry_buffer[-1].copy()
    return None


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


# ══════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════

# ── Health check ──────────────────────────────────────────────
@app.route("/", methods=["GET"])
def index():
    with _buffer_lock:
        buf_size = len(_telemetry_buffer)
    return jsonify({
        "status": "ClimateOS backend running",
        "firebase": "connected" if db is not None else "NOT connected",
        "buffer_size": buf_size,
        "time": datetime.now(timezone.utc).isoformat(),
    })


# ── 1. Telemetry Ingestion ────────────────────────────────────
@app.route("/api/telemetry", methods=["POST"])
def telemetry():
    if db is None:
        return jsonify({"error": "Database not connected."}), 503

    body = request.get_json(silent=True) or {}

    errors = []
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
    now = datetime.now(timezone.utc)

    # 1. Simpan ke Firestore (persist)
    try:
        db.collection("telemetry").add({
            "temperature": temperature,
            "humidity":    humidity,
            "device_id":   device_id,
            "timestamp":   now,
        })
        logger.info("Telemetry saved: %s temp=%.2f hum=%.2f", device_id, temperature, humidity)
    except Exception as exc:
        logger.error("Firestore write failed: %s", exc)
        return jsonify({"error": f"Firestore write failed: {exc}"}), 500

    # 2. Simpan ke memory buffer (0 Firestore reads untuk endpoint GET)
    _add_to_buffer({
        "temperature": temperature,
        "humidity": humidity,
        "device_id": device_id,
        "timestamp": now,
    })

    # 3. Discord alert (best-effort)
    try:
        webhook_url = _require_env("DISCORD_WEBHOOK_URL")
        process_alert(temperature, humidity, device_id, webhook_url)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)

    return jsonify({"status": "ok", "timestamp": now.isoformat()}), 201


# ── 1b. Latest (single reading for gauges) ────────────────────
@app.route("/api/latest", methods=["GET"])
def latest():
    """100% from memory — 0 Firestore reads."""
    record = _get_latest_from_buffer()
    if not record:
        return jsonify({"error": "No data available yet"}), 404

    return jsonify({
        "temperature": record["temperature"],
        "humidity": record["humidity"],
        "device_id": record["device_id"],
        "timestamp": _serialize_ts(record["timestamp"]),
    })


# ── 2. History ────────────────────────────────────────────────
@app.route("/api/history", methods=["GET"])
def history():
    """100% from memory — 0 Firestore reads."""
    range_param = request.args.get("range", "1h")
    range_minutes = {"live": 15, "1h": 60, "3h": 180, "12h": 720, "24h": 1440}.get(range_param, 60)

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=range_minutes)
    records = _get_buffer_since(cutoff)

    result = [{
        "temperature": r["temperature"],
        "humidity": r["humidity"],
        "device_id": r["device_id"],
        "timestamp": _serialize_ts(r["timestamp"]),
    } for r in records]

    return jsonify({"data": result, "count": len(result)})


# ── 3. Stats ──────────────────────────────────────────────────
@app.route("/api/stats", methods=["GET"])
def stats():
    """100% from memory — 0 Firestore reads."""
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    records = _get_buffer_since(today_start)

    if not records:
        return jsonify({"count": 0})

    temps  = [r["temperature"] for r in records if r.get("temperature") is not None]
    humids = [r["humidity"]    for r in records if r.get("humidity") is not None]

    return jsonify({
        "count":        len(records),
        "temp_min":     round(min(temps), 2) if temps else None,
        "temp_max":     round(max(temps), 2) if temps else None,
        "temp_avg":     round(sum(temps) / len(temps), 2) if temps else None,
        "humidity_min": round(min(humids), 2) if humids else None,
        "humidity_max": round(max(humids), 2) if humids else None,
        "humidity_avg": round(sum(humids) / len(humids), 2) if humids else None,
    })


# ── 4. Weather ────────────────────────────────────────────────
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


# ── 5. AI Chat ────────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
def chat():
    body         = request.get_json(silent=True) or {}
    user_message = body.get("message", "").strip()

    if not user_message:
        return jsonify({"error": "message field wajib diisi"}), 400

    try:
        gemini_api_key = _require_env("GEMINI_API_KEY")
        reply          = handle_chat(user_message, gemini_api_key)
        return jsonify({"reply": reply})
    except RuntimeError as exc:
        logger.error("Chat config error: %s", exc)
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:
        logger.error("Chat error: %s", exc)
        return jsonify({"error": "AI tidak tersedia, coba lagi."}), 500


# ── Bootstrap & Run ───────────────────────────────────────────
# Load existing data from Firestore into memory on startup
_bootstrap_buffer()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
