"""
app.py — ClimateOS Backend (Flask)
Deploy ke Render.com sebagai Web Service gratis.
Environment variables diset di Render Dashboard (bukan .env file).

OPTIMASI QUOTA FIRESTORE:
- Server-side in-memory cache untuk history, stats, latest
- Telemetry write juga meng-update cache latest secara langsung
- Mengurangi Firestore reads dari ~50,000/hari menjadi ~3,000/hari
"""

import json
import logging
import os
import time
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
try:
    if not firebase_admin._apps:
        sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
        if sa_json:
            sa_dict = json.loads(sa_json)
            cred = credentials.Certificate(sa_dict)
            firebase_admin.initialize_app(cred)
            logger.info("Firebase initialized with service account credentials.")
        else:
            logger.warning("FIREBASE_SERVICE_ACCOUNT_JSON not set! Trying default credentials...")
            firebase_admin.initialize_app()
    db = firestore.client()
    logger.info("Firestore client ready.")
except Exception as exc:
    logger.error("Firebase initialization FAILED: %s", exc)
    logger.error("Make sure FIREBASE_SERVICE_ACCOUNT_JSON env variable is set correctly in Render Dashboard.")
    db = None


# ── In-memory cache ───────────────────────────────────────────
# Mengurangi Firestore reads secara drastis pada free tier
_cache = {
    "latest": {"data": None, "ts": 0},
    "history": {},      # key = range_param, value = {"data": ..., "ts": ...}
    "stats": {"data": None, "ts": 0},
}

CACHE_TTL = {
    "latest": 10,       # 10 detik — gauge update
    "history": 15,      # 15 detik — chart refresh
    "stats": 60,        # 60 detik — stats jarang berubah
}


def _cache_valid(key, sub_key=None):
    """Check if cache entry is still fresh."""
    if sub_key:
        entry = _cache.get(key, {}).get(sub_key)
    else:
        entry = _cache.get(key)
    if not entry or entry.get("data") is None:
        return False
    return (time.time() - entry["ts"]) < CACHE_TTL.get(key, 30)


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
    return jsonify({
        "status": "ClimateOS backend running",
        "firebase": "connected" if db is not None else "NOT connected",
        "time": datetime.now(timezone.utc).isoformat(),
    })


# ── 1. Telemetry Ingestion ────────────────────────────────────
@app.route("/api/telemetry", methods=["POST"])
def telemetry():
    """
    POST /api/telemetry
    Body: { "temperature": float, "humidity": float, "device_id": str }
    """
    if db is None:
        return jsonify({"error": "Database not connected. Check FIREBASE_SERVICE_ACCOUNT_JSON."}), 503

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
    try:
        now = datetime.now(timezone.utc)
        db.collection("telemetry").add({
            "temperature": temperature,
            "humidity":    humidity,
            "device_id":   device_id,
            "timestamp":   now,
        })
        logger.info("Telemetry saved: %s temp=%.2f hum=%.2f", device_id, temperature, humidity)

        # Update latest cache langsung (hemat 1 Firestore read per poll)
        _cache["latest"] = {
            "data": {
                "temperature": temperature,
                "humidity": humidity,
                "device_id": device_id,
                "timestamp": now.isoformat(),
            },
            "ts": time.time(),
        }

        # Invalidate history & stats cache agar data baru muncul
        _cache["history"] = {}
        _cache["stats"]["ts"] = 0

    except Exception as exc:
        logger.error("Firestore write failed: %s", exc)
        return jsonify({"error": f"Firestore write failed: {exc}"}), 500

    # Discord alert (best-effort)
    try:
        webhook_url = _require_env("DISCORD_WEBHOOK_URL")
        process_alert(temperature, humidity, device_id, webhook_url)
    except Exception as exc:
        logger.warning("Alert skipped: %s", exc)

    return jsonify({"status": "ok", "timestamp": now.isoformat()}), 201


# ── 1b. Latest (single reading for gauges) ────────────────────
@app.route("/api/latest", methods=["GET"])
def latest():
    """
    GET /api/latest
    Returns the single most recent telemetry reading.
    Uses cache to minimize Firestore reads.
    """
    if db is None:
        return jsonify({"error": "Database not connected"}), 503

    # Return from cache if fresh
    if _cache_valid("latest"):
        return jsonify(_cache["latest"]["data"])

    try:
        query = (
            db.collection("telemetry")
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(1)
        )
        docs = list(query.stream())
        if not docs:
            return jsonify({"error": "No data available"}), 404

        d = docs[0].to_dict()
        ts = d.get("timestamp")
        if hasattr(ts, "isoformat"):
            ts = ts.isoformat()

        result = {
            "temperature": d.get("temperature"),
            "humidity": d.get("humidity"),
            "device_id": d.get("device_id"),
            "timestamp": ts,
        }

        _cache["latest"] = {"data": result, "ts": time.time()}
        return jsonify(result)
    except Exception as exc:
        logger.error("Latest endpoint error: %s", exc)
        return jsonify({"error": f"Latest query failed: {exc}"}), 500


# ── 2. History ────────────────────────────────────────────────
@app.route("/api/history", methods=["GET"])
def history():
    """
    GET /api/history?range=live|1h|3h|12h|24h
    Cached server-side to reduce Firestore reads.
    """
    if db is None:
        return jsonify({"error": "Database not connected"}), 503

    range_param = request.args.get("range", "1h")

    # Return from cache if fresh
    if _cache_valid("history", range_param):
        return jsonify(_cache["history"][range_param]["data"])

    try:
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

        result = {"data": records, "count": len(records)}
        _cache["history"][range_param] = {"data": result, "ts": time.time()}
        return jsonify(result)
    except Exception as exc:
        logger.error("History endpoint error: %s", exc)
        return jsonify({"error": f"History query failed: {exc}"}), 500


# ── 3. Stats ──────────────────────────────────────────────────
@app.route("/api/stats", methods=["GET"])
def stats():
    """
    GET /api/stats
    Statistik hari ini: min, max, avg, count.
    Cached 60 detik.
    """
    if db is None:
        return jsonify({"error": "Database not connected"}), 503

    # Return from cache if fresh
    if _cache_valid("stats"):
        return jsonify(_cache["stats"]["data"])

    try:
        now         = datetime.now(timezone.utc)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        query   = (
            db.collection("telemetry")
            .where("timestamp", ">=", today_start)
            .order_by("timestamp")
        )
        records = [doc.to_dict() for doc in query.stream()]

        if not records:
            result = {"count": 0}
        else:
            temps  = [r["temperature"] for r in records if "temperature" in r]
            humids = [r["humidity"]    for r in records if "humidity"    in r]
            result = {
                "count":        len(records),
                "temp_min":     round(min(temps), 2),
                "temp_max":     round(max(temps), 2),
                "temp_avg":     round(sum(temps) / len(temps), 2),
                "humidity_min": round(min(humids), 2),
                "humidity_max": round(max(humids), 2),
                "humidity_avg": round(sum(humids) / len(humids), 2),
            }

        _cache["stats"] = {"data": result, "ts": time.time()}
        return jsonify(result)
    except Exception as exc:
        logger.error("Stats endpoint error: %s", exc)
        return jsonify({"error": f"Stats query failed: {exc}"}), 500


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
