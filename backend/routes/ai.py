"""
routes/ai.py  — Context-injected Gemini 2.5 Flash chat endpoint.
Fix: ROOM_CONFIG di-import dari services/notifier sebagai single source of truth
sehingga AI mengenali nama ruangan dari layar (bukan hanya device_id backend).
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Any
import google.generativeai as genai
from firebase_admin import firestore

from services.buffer import get_buffer_since, get_buffer_snapshot
from services.notifier import ROOM_CONFIG   # single source of truth: nama & threshold

logger = logging.getLogger(__name__)

GEMINI_MODEL   = "gemini-2.5-flash"
LAST_N_RECORDS = 50
WIB            = timezone(timedelta(hours=7))


def _fetch_context_data() -> dict[str, Any]:
    now         = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    snapshot = get_buffer_snapshot()
    records  = list(reversed(snapshot[-LAST_N_RECORDS:]))

    today_records = get_buffer_since(today_start)
    stats = {}
    if today_records:
        temps  = [r["temperature"] for r in today_records if r.get("temperature") is not None]
        humids = [r["humidity"]    for r in today_records if r.get("humidity")    is not None]
        stats  = {
            "count":        len(today_records),
            "temp_min":     round(min(temps),              2) if temps  else None,
            "temp_max":     round(max(temps),              2) if temps  else None,
            "temp_avg":     round(sum(temps) / len(temps), 2) if temps  else None,
            "humidity_min": round(min(humids),             2) if humids else None,
            "humidity_max": round(max(humids),             2) if humids else None,
            "humidity_avg": round(sum(humids)/len(humids), 2) if humids else None,
        }

    outdoor = {}
    try:
        db          = firestore.client()
        outdoor_doc = db.collection("_system").document("weather_cache").get()
        outdoor     = outdoor_doc.to_dict() if outdoor_doc.exists else {}
    except Exception:
        pass

    return {
        "recent_records":       records,
        "today_stats":          stats,
        "outdoor_weather":      outdoor,
        "context_generated_at": datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S WIB"),
    }


def _format_ts_wib(ts) -> str:
    if ts is None:
        return "N/A"
    if hasattr(ts, "astimezone"):
        return ts.astimezone(WIB).strftime("%H:%M:%S WIB")
    return str(ts)


def _build_room_map() -> str:
    """Bangun tabel pemetaan device_id -> nama ruangan dari ROOM_CONFIG."""
    lines = []
    for did, conf in ROOM_CONFIG.items():
        lines.append(
            f"  {did:<12} => {conf['name']} ({conf['floor']}) | "
            f"Suhu: {conf['tempMin']}-{conf['tempMax']}C | "
            f"Humidity: {conf['humMin']}-{conf['humMax']}%"
        )
    return "\n".join(lines)


def _build_system_prompt(context: dict[str, Any]) -> str:
    stats   = context.get("today_stats", {})
    outdoor = context.get("outdoor_weather", {})
    records = context.get("recent_records", [])

    delta_str = "N/A"
    if stats.get("temp_avg") is not None and outdoor.get("temperature") is not None:
        delta     = round(stats["temp_avg"] - outdoor["temperature"], 2)
        delta_str = f"{'+' if delta >= 0 else ''}{delta}C"

    recent_summary = ""
    if records:
        latest    = records[0]
        ts_str    = _format_ts_wib(latest.get("timestamp"))
        did       = latest.get("device_id", "?")
        room_name = ROOM_CONFIG.get(did, {}).get("name", did)
        recent_summary = (
            f"Most recent: {latest.get('temperature', 'N/A')}C / "
            f"{latest.get('humidity', 'N/A')}% at {ts_str} "
            f"({did} = {room_name})"
        )

    # Setiap baris sensor menyertakan nama ruangan di layar
    recent_lines = "\n".join(
        "  [{ts}] {did} ({name}): {temp}C / {hum}%".format(
            ts   = _format_ts_wib(r.get("timestamp")),
            did  = r.get("device_id", "?"),
            name = ROOM_CONFIG.get(r.get("device_id", ""), {}).get("name", "Unknown"),
            temp = r.get("temperature", "?"),
            hum  = r.get("humidity",    "?"),
        )
        for r in records[:10]
    )

    room_names = ", ".join(conf["name"] for conf in ROOM_CONFIG.values())
    room_map   = _build_room_map()

    prompt = (
        "Kamu adalah asisten klinis AI untuk sistem monitoring iklim MediClimate RS.\n"
        "Kamu memiliki akses ke data sensor real-time dari bangsal anak dan neonatal.\n"
        "\n"
        "KONTEKS MEDIS:\n"
        f"- Bangsal yang dipantau: {room_names}\n"
        "- Pasien utama: bayi baru lahir, bayi prematur, anak-anak\n"
        "- Risiko: hipotermia neonatal, heat stress, pertumbuhan bakteri (humidity tinggi), dehidrasi kulit bayi\n"
        "\n"
        "PETA RUANGAN (device_id sensor => nama tampilan di layar + threshold standar):\n"
        f"{room_map}\n"
        "\n"
        "PENTING: Ketika user menyebut nama ruangan seperti 'Bangsal Anak Umum', 'NICU', 'Bangsal Bayi',\n"
        "atau 'Ruang Isolasi', cocokkan dengan device_id di tabel PETA RUANGAN di atas untuk membaca\n"
        "datanya. Selalu jawab menggunakan NAMA TAMPILAN (bukan device_id) dalam respons.\n"
        "\n"
        "--- LIVE SENSOR CONTEXT ---\n"
        f"Context generated at: {context.get('context_generated_at', 'N/A')}\n"
        f"{recent_summary}\n"
        "\n"
        f"TODAY'S INDOOR SUMMARY ({stats.get('count', 0)} data points):\n"
        f"  Temperature -- Min: {stats.get('temp_min', 'N/A')}C | Max: {stats.get('temp_max', 'N/A')}C | Avg: {stats.get('temp_avg', 'N/A')}C\n"
        f"  Humidity    -- Min: {stats.get('humidity_min', 'N/A')}% | Max: {stats.get('humidity_max', 'N/A')}% | Avg: {stats.get('humidity_avg', 'N/A')}%\n"
        "\n"
        "OUTDOOR SEMARANG (OpenWeatherMap):\n"
        f"  Temperature: {outdoor.get('temperature', 'N/A')}C | Feels like: {outdoor.get('feels_like', 'N/A')}C\n"
        f"  Humidity: {outdoor.get('humidity', 'N/A')}% | Wind: {outdoor.get('wind_speed', 'N/A')} m/s\n"
        f"  Conditions: {outdoor.get('description', 'N/A')}\n"
        "\n"
        f"INDOOR vs OUTDOOR DELTA: {delta_str}\n"
        "\n"
        f"LAST {len(records)} READINGS (newest first, WIB/UTC+7):\n"
        f"{recent_lines}\n"
        "--- END CONTEXT ---\n"
        "\n"
        "CARA MERESPONS:\n"
        "- Selalu sebut nama ruangan (bukan device_id), contoh: 'Bangsal Anak Umum' bukan 'BANGSAL-B'\n"
        "- Jika kondisi di luar threshold, rekomendasikan tindakan spesifik\n"
        "- Bahasa Indonesia yang jelas, tidak terlalu teknis\n"
        "- Ringkasan shift: format terstruktur (ruangan, status, durasi deviasi, tindakan)\n"
        "- Tambahkan disclaimer: keputusan medis tetap di tangan tenaga kesehatan\n"
        "\n"
        "Sistem ini adalah alat bantu monitoring. Keputusan medis tetap wewenang tenaga kesehatan.\n"
    )
    return prompt


def handle_chat(user_message: str, gemini_api_key: str, history: list = None) -> str:
    """
    Proses pesan user dengan context sensor real-time sebagai system prompt.

    Parameters:
        user_message   : Pesan terbaru dari user
        gemini_api_key : API key Gemini
        history        : List riwayat [{role: 'user'|'model', text: '...'}]
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

    formatted_history = []
    if history:
        for msg in history:
            role = "user" if msg.get("role") == "user" else "model"
            text = msg.get("text", "").strip()
            if text:
                formatted_history.append({"role": role, "parts": [text]})

    try:
        model = genai.GenerativeModel(
            model_name=GEMINI_MODEL,
            system_instruction=system_prompt,
        )
        chat_session = model.start_chat(history=formatted_history)
        response     = chat_session.send_message(user_message)
        return response.text
    except Exception as exc:
        logger.error("Gemini API error: %s", exc)
        raise RuntimeError(f"AI service unavailable: {exc}") from exc
