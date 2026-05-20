"""
routes/ai.py
Context-injected Gemini 2.5 Flash chat endpoint.
Queries last 50 telemetry records + today's stats and injects them
as a hidden system prompt before forwarding the user message.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Any
import google.generativeai as genai
from firebase_admin import firestore

logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-2.5-flash"
LAST_N_RECORDS = 50
WIB = timezone(timedelta(hours=7))  # Waktu Indonesia Barat (UTC+7)


def _fetch_context_data() -> dict[str, Any]:
    """
    Build structured analytical context from in-memory buffer.
    Uses 0 Firestore reads — all data comes from app.py's memory buffer.
    Only outdoor weather still reads from Firestore (cached by weather service).
    """
    from app import _get_buffer_since, _telemetry_buffer, _buffer_lock

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Last N records from memory (newest first)
    with _buffer_lock:
        records = list(reversed(_telemetry_buffer[-LAST_N_RECORDS:]))

    # Today's records from memory
    today_records = _get_buffer_since(today_start)

    stats = {}
    if today_records:
        temps = [r["temperature"] for r in today_records if r.get("temperature") is not None]
        humids = [r["humidity"] for r in today_records if r.get("humidity") is not None]
        stats = {
            "count": len(today_records),
            "temp_min": round(min(temps), 2) if temps else None,
            "temp_max": round(max(temps), 2) if temps else None,
            "temp_avg": round(sum(temps) / len(temps), 2) if temps else None,
            "humidity_min": round(min(humids), 2) if humids else None,
            "humidity_max": round(max(humids), 2) if humids else None,
            "humidity_avg": round(sum(humids) / len(humids), 2) if humids else None,
        }

    # Outdoor weather cache (still from Firestore, but cached by weather service)
    outdoor = {}
    try:
        db = firestore.client()
        outdoor_doc = db.collection("_system").document("weather_cache").get()
        outdoor = outdoor_doc.to_dict() if outdoor_doc.exists else {}
    except Exception:
        pass

    return {
        "recent_records": records,
        "today_stats": stats,
        "outdoor_weather": outdoor,
        "context_generated_at": datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S WIB"),
    }


def _format_ts_wib(ts) -> str:
    """Convert a Firestore timestamp to WIB string."""
    if ts is None:
        return "N/A"
    if hasattr(ts, 'astimezone'):
        return ts.astimezone(WIB).strftime("%H:%M:%S WIB")
    return str(ts)


def _build_system_prompt(context: dict[str, Any]) -> str:
    stats = context.get("today_stats", {})
    outdoor = context.get("outdoor_weather", {})
    records = context.get("recent_records", [])

    # Calculate indoor vs outdoor delta if both are available
    delta_str = "N/A"
    if stats.get("temp_avg") is not None and outdoor.get("temperature") is not None:
        delta = round(stats["temp_avg"] - outdoor["temperature"], 2)
        delta_str = f"{'+' if delta >= 0 else ''}{delta}°C"

    recent_summary = ""
    if records:
        latest = records[0]
        ts = latest.get('timestamp', None)
        ts_str = 'N/A'
        if ts is not None:
            if hasattr(ts, 'astimezone'):
                ts_str = ts.astimezone(WIB).strftime("%H:%M:%S WIB")
            else:
                ts_str = str(ts)
        recent_summary = (
            f"Most recent reading: {latest.get('temperature', 'N/A')}°C / "
            f"{latest.get('humidity', 'N/A')}% at {ts_str}"
        )

    return f"""Kamu adalah asisten klinis AI untuk sistem monitoring iklim MediClimate RS di rumah sakit. Kamu memiliki akses ke data sensor real-time dari bangsal anak dan neonatal.

KONTEKS MEDIS KAMU:
- Bangsal yang dipantau: NICU, Bangsal Bayi Baru Lahir, Bangsal Anak Umum, Ruang Isolasi
- Pasien utama: bayi baru lahir, bayi prematur, anak-anak
- Risiko utama yang kamu pantau:
  * Hipotermia neonatal (suhu ruang terlalu dingin)
  * Heat stress pada bayi (suhu ruang terlalu panas)
  * Pertumbuhan bakteri/jamur (humidity terlalu tinggi)
  * Dehidrasi kulit bayi (humidity terlalu rendah)

STANDAR THRESHOLD YANG KAMU GUNAKAN:
- NICU: Suhu 24-26°C | Humidity 50-60%
- Bangsal Bayi: Suhu 22-26°C | Humidity 45-60%
- Bangsal Anak Umum: Suhu 20-24°C | Humidity 40-60%
- Ruang Isolasi: Suhu 22-25°C | Humidity 45-55%

You have exclusive access to the following LIVE sensor data context. Use it to give highly specific, data-driven, and contextual answers. Do NOT mention that you were given this data unless directly asked.

--- LIVE SENSOR CONTEXT ---
Context generated at: {context.get("context_generated_at", "N/A")}
{recent_summary}

TODAY'S INDOOR SUMMARY ({stats.get("count", 0)} data points):
  Temperature — Min: {stats.get("temp_min", "N/A")}°C | Max: {stats.get("temp_max", "N/A")}°C | Avg: {stats.get("temp_avg", "N/A")}°C
  Humidity    — Min: {stats.get("humidity_min", "N/A")}% | Max: {stats.get("humidity_max", "N/A")}% | Avg: {stats.get("humidity_avg", "N/A")}%

OUTDOOR SEMARANG (OpenWeatherMap):
  Temperature: {outdoor.get("temperature", "N/A")}°C | Feels like: {outdoor.get("feels_like", "N/A")}°C
  Humidity: {outdoor.get("humidity", "N/A")}% | Wind: {outdoor.get("wind_speed", "N/A")} m/s
  Conditions: {outdoor.get("description", "N/A")}

INDOOR vs OUTDOOR DELTA (ΔT):
  ΔT = {delta_str}

LAST {len(records)} READINGS (newest first, times in WIB/UTC+7):
{chr(10).join(
    f"  [{_format_ts_wib(r.get('timestamp'))}] {r.get('device_id', '?')}: {r.get('temperature', '?')}°C / {r.get('humidity', '?')}%"
    for r in records[:10]
)}
--- END CONTEXT ---

IMPORTANT: All timestamps above are in WIB (Waktu Indonesia Barat, UTC+7). Always refer to times in WIB when responding.

CARA KAMU MERESPONS:
- Selalu sebut nama ruangan spesifik, bukan "ruangan ini"
- Jika ada kondisi di luar threshold, langsung rekomendasikan tindakan: "Segera periksa AC ruangan / hubungi teknisi / pantau kondisi pasien"
- Gunakan bahasa Indonesia yang jelas dan tidak terlalu teknis
- Jika ditanya ringkasan shift, berikan format terstruktur: ruangan, status, durasi deviasi, tindakan yang disarankan
- PENTING: Selalu tambahkan disclaimer bahwa keputusan medis tetap ada di tangan tenaga kesehatan

⚕️ Sistem ini adalah alat bantu monitoring. Keputusan medis tetap menjadi wewenang tenaga kesehatan.
"""


def handle_chat(user_message: str, gemini_api_key: str) -> str:
    """
    Process a user chat message by injecting live sensor context as system
    prompt and forwarding to Gemini 2.5 Flash. Returns the AI response text.
    """
    if not user_message or not user_message.strip():
        return "Please provide a message."

    genai.configure(api_key=gemini_api_key)

    try:
        context = _fetch_context_data()
    except Exception as exc:
        logger.warning("Could not fetch sensor context: %s", exc)
        context = {}

    system_prompt = _build_system_prompt(context)

    try:
        model = genai.GenerativeModel(
            model_name=GEMINI_MODEL,
            system_instruction=system_prompt,
        )
        response = model.generate_content(user_message)
        return response.text
    except Exception as exc:
        logger.error("Gemini API error: %s", exc)
        raise RuntimeError(f"AI service unavailable: {exc}") from exc
