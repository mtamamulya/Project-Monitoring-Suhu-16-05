"""
app.py — ClimateOS Backend (Flask)
Deploy ke Render.com sebagai Web Service gratis.
Environment variables diset di Render Dashboard (bukan .env file).
"""

import json
import logging
import os
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
# Render menyimpan isi service account JSON sebagai env variable
# FIREBASE_SERVICE_ACCOUNT_JSON (string JSON, bukan path file)
if not firebase_admin._apps:
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if sa_json:
        import json as _json
        sa_dict = _json.loads(sa_json)
        cred = credentials.Certificate(sa_dict)
        firebase_admin.initialize_app(cred)
    else:
        # Fallback: pakai Application Default Credentials (lokal/emulator)
        firebase_admin.initialize_app()

db = firestore.client()


# ── Helper env ────────────────────────────────────────────────
def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Environment variable '{name}' belum diset di Render Dashboard.")
    return value


# ══════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════

# ── Health check ──────────────────────────────────────────────
@app.route("/", methods=["GET"])
def index():
    return jsonify({"status": "ClimateOS backend running", "time": datetime.now(timezone.utc).isoformat()})


# ── 1. Telemetry Ingestion ────────────────────────────────────
@app.route("/api/telemetry", methods=["POST"])
def telemetry():
    """
    POST /api/telemetry
    Body: { "temperature": float, "humidity": float, "device_id": str }
    """
    body = request.get_json(silent=True) or {}

    # Validasi
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

    # Simpan ke Firestore
    now = datetime.now(timezone.utc)
    db.collection("telemetry").add({
        "temperature": temperature,
        "humidity":    humidity,
        "device_id":   device_id,
        "timestamp":   now,
    })
    logger.info("Telemetry saved: %s temp=%.2f hum=%.2f", device_id, temperature, humidity)

    # Discord alert (best-effort)
    try:
        webhook_url = _require_env("DISCORD_WEBHOOK_URL")
        process_alert(temperature, humidity, device_id, webhook_url)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)

    return jsonify({"status": "ok", "timestamp": now.isoformat()}), 201


# ── 2. History ────────────────────────────────────────────────
@app.route("/api/history", methods=["GET"])
def history():
    """
    GET /api/history?range=live|1h|3h|12h|24h
    """
    range_param   = request.args.get("range", "1h")
    range_minutes = {"live": 15, "1h": 60, "3h": 180, "12h": 720, "24h": 1440}.get(range_param, 60)

    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=range_minutes)

    query = (
        db.collection("telemetry")
        .where("timestamp", ">=", cutoff)
        .order_by("timestamp", direction=firestore.Query.ASCENDING)
        .limit(500)
    )

    records = []
    for doc in query.stream():
        d  = doc.to_dict()
        ts = d.get("timestamp")
        if hasattr(ts, "isoformat"):
            ts = ts.isoformat()
        records.append({
            "temperature": d.get("temperature"),
            "humidity":    d.get("humidity"),
            "device_id":   d.get("device_id"),
            "timestamp":   ts,
        })

    return jsonify({"data": records, "count": len(records)})


# ── 3. Stats ──────────────────────────────────────────────────
@app.route("/api/stats", methods=["GET"])
def stats():
    """
    GET /api/stats
    Statistik hari ini: min, max, avg, count.
    """
    now         = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    query   = (
        db.collection("telemetry")
        .where("timestamp", ">=", today_start)
        .order_by("timestamp")
    )
    records = [doc.to_dict() for doc in query.stream()]

    if not records:
        return jsonify({"count": 0})

    temps  = [r["temperature"] for r in records if "temperature" in r]
    humids = [r["humidity"]    for r in records if "humidity"    in r]

    return jsonify({
        "count":        len(records),
        "temp_min":     round(min(temps), 2),
        "temp_max":     round(max(temps), 2),
        "temp_avg":     round(sum(temps) / len(temps), 2),
        "humidity_min": round(min(humids), 2),
        "humidity_max": round(max(humids), 2),
        "humidity_avg": round(sum(humids) / len(humids), 2),
    })


# ── 4. Weather ────────────────────────────────────────────────
@app.route("/api/weather", methods=["GET"])
def weather():
    """
    GET /api/weather
    Cuaca outdoor Semarang (cached 10 menit di Firestore).
    """
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
    """
    POST /api/chat
    Body: { "message": string }
    """
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


# ── Run ───────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
