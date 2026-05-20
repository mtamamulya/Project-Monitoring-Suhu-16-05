import logging
import os
import requests
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

ROOM_CONFIG = {
    "NICU-01":    {"name": "NICU",              "tempMin": 24.0, "tempMax": 26.0, "humMin": 50.0, "humMax": 60.0},
    "BANGSAL-A":  {"name": "Bangsal Bayi",      "tempMin": 22.0, "tempMax": 26.0, "humMin": 45.0, "humMax": 60.0},
    "BANGSAL-B":  {"name": "Bangsal Anak Umum", "tempMin": 20.0, "tempMax": 24.0, "humMin": 40.0, "humMax": 60.0},
    "ISOLASI-01": {"name": "Ruang Isolasi",     "tempMin": 22.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0},
}

_alert_states = {}
_state_loaded = False
WIB = timezone(timedelta(hours=7))

def _load_states():
    global _state_loaded
    if _state_loaded:
        return
    try:
        from firebase_admin import firestore
        db = firestore.client()
        docs = db.collection("_alerts").stream()
        for doc in docs:
            # We skip 'current' or specific non-device docs if any, but since we use device_id as doc id
            if doc.id in ROOM_CONFIG:
                _alert_states[doc.id] = doc.to_dict()
    except Exception as exc:
        logger.warning(f"Could not load alert states: {exc}")
    _state_loaded = True

def _save_state(device_id: str, state_data: dict):
    try:
        from firebase_admin import firestore
        db = firestore.client()
        db.collection("_alerts").document(device_id).set(state_data)
    except Exception as exc:
        logger.warning(f"Could not save alert state: {exc}")

def send_telegram(token, chat_id, message):
    if not token or not chat_id:
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        requests.post(url, json={"chat_id": chat_id, "text": message, "parse_mode": "HTML"}, timeout=10)
    except Exception as e:
        logger.error(f"Telegram send error: {e}")

def _send_discord_embed(webhook_url: str, embed: dict):
    if not webhook_url: return
    try:
        requests.post(webhook_url, json={"embeds": [embed]}, timeout=10)
    except Exception as e:
        logger.error(f"Discord send error: {e}")

def get_deviations(temp, hum, room_conf):
    d_temp = 0.0
    if temp < room_conf['tempMin']: d_temp = room_conf['tempMin'] - temp
    elif temp > room_conf['tempMax']: d_temp = temp - room_conf['tempMax']
    
    d_hum = 0.0
    if hum < room_conf['humMin']: d_hum = room_conf['humMin'] - hum
    elif hum > room_conf['humMax']: d_hum = hum - room_conf['humMax']
    return d_temp, d_hum

def process_alert(temperature: float, humidity: float, device_id: str):
    if device_id not in ROOM_CONFIG:
        return # Skip unknown devices
    
    _load_states()
    now = datetime.now(timezone.utc)
    room = ROOM_CONFIG[device_id]
    
    state = _alert_states.get(device_id, {
        "level": 0,
        "last_alert_sent_at": None,
        "critical_start_at": None,
        "escalated_to_emergency": False
    })
    
    d_temp, d_hum = get_deviations(temperature, humidity, room)
    
    # Evaluate current condition
    condition_level = 0
    if temperature >= 32.0 or temperature <= 18.0:
        condition_level = 3
    elif d_temp > 2.0 or d_hum > 10.0:
        condition_level = 2
    elif d_temp > 0 or d_hum > 0:
        condition_level = 1
        
    # Handle Critical (Level 2) time condition for Temp
    if condition_level == 2:
        if state.get("critical_start_at") is None:
            state["critical_start_at"] = now.isoformat()
        
        # Temp > 2C requires >3 minutes to trigger Level 2.
        # But if Hum > 10%, it's immediate? Prompt says "ATAU humidity keluar range >10%"
        c_start = datetime.fromisoformat(state["critical_start_at"]) if state.get("critical_start_at") else now
        if d_temp > 2.0 and d_hum <= 10.0:
            if (now - c_start).total_seconds() < 180:
                condition_level = 1 # Downgrade to level 1 if < 3 mins
    else:
        state["critical_start_at"] = None

    # Handle Escalation Level 2 -> Level 3 (unresolved for 15 mins)
    if condition_level == 2:
        c_start = datetime.fromisoformat(state["critical_start_at"]) if state.get("critical_start_at") else now
        if (now - c_start).total_seconds() >= 900: # 15 mins
            condition_level = 3
            state["escalated_to_emergency"] = True

    if condition_level < 3:
        state["escalated_to_emergency"] = False

    # Determine if we should send an alert based on cooldowns
    should_send = False
    last_sent = datetime.fromisoformat(state["last_alert_sent_at"]) if state.get("last_alert_sent_at") else None
    
    if condition_level > 0 and (state["level"] != condition_level):
        should_send = True # State changed
    elif condition_level > 0 and last_sent:
        elapsed = (now - last_sent).total_seconds() / 60.0
        if condition_level == 1 and elapsed >= 10:
            should_send = True
        elif condition_level == 2 and elapsed >= 5:
            should_send = True
        elif condition_level == 3 and elapsed >= 5:
            should_send = True
    elif condition_level > 0 and not last_sent:
        should_send = True

    # Check for recovery
    if condition_level == 0 and state["level"] > 0:
        # Recovered
        msg = f"✅ <b>RESOLVED</b> — {room['name']}\nSuhu dan Kelembaban kembali normal.\nSuhu: {temperature}°C\nHumidity: {humidity}%"
        send_telegram(os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID_PERAWAT"), msg)
        state["level"] = 0
        state["last_alert_sent_at"] = None
        state["escalated_to_emergency"] = False
        _alert_states[device_id] = state
        _save_state(device_id, state)
        return

    state["level"] = condition_level

    if should_send:
        state["last_alert_sent_at"] = now.isoformat()
        _alert_states[device_id] = state
        _save_state(device_id, state)
        
        now_wib = datetime.now(WIB).strftime("%H:%M:%S WIB")
        discord_url = os.environ.get("DISCORD_WEBHOOK_URL")
        tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        tg_perawat = os.environ.get("TELEGRAM_CHAT_ID_PERAWAT")
        tg_direktur = os.environ.get("TELEGRAM_CHAT_ID_DIREKTUR")

        if condition_level == 1:
            # Level 1 -> Discord
            embed = {
                "title": f"⚠️ WARNING — {room['name']}",
                "description": f"Suhu/Humidity di luar batas normal.",
                "color": 0xF6E05E,
                "fields": [
                    {"name": "Suhu", "value": f"{temperature}°C (Limit: {room['tempMin']}-{room['tempMax']})", "inline": True},
                    {"name": "Humidity", "value": f"{humidity}% (Limit: {room['humMin']}-{room['humMax']})", "inline": True}
                ],
                "footer": {"text": f"MediClimate RS • {now_wib}"}
            }
            _send_discord_embed(discord_url, embed)
            
        elif condition_level == 2:
            # Level 2 -> Telegram Perawat
            msg = (
                f"🚨 <b>CRITICAL ALERT</b> — {room['name']}\n"
                f"Suhu: {temperature}°C (threshold: {room['tempMin']}–{room['tempMax']}°C)\n"
                f"Humidity: {humidity}% (threshold: {room['humMin']}–{room['humMax']}%)\n"
                f"Device: {device_id}\n"
                f"Waktu: {now_wib}\n"
                f"Segera periksa kondisi ruangan."
            )
            send_telegram(tg_token, tg_perawat, msg)
            
        elif condition_level == 3:
            # Level 3 -> Telegram Direktur
            status_text = "ESKALASI L2 (TIDAK RESOLVED > 15 MENIT)" if state.get("escalated_to_emergency") else "SUHU KRITIS (>=32 atau <=18)"
            msg = (
                f"🔴 <b>EMERGENCY</b> — {room['name']}\n"
                f"⚠️ <b>PERHATIAN SEGERA DIPERLUKAN</b>\n"
                f"Suhu: {temperature}°C (threshold: {room['tempMin']}–{room['tempMax']}°C)\n"
                f"Humidity: {humidity}% (threshold: {room['humMin']}–{room['humMax']}%)\n"
                f"Device: {device_id}\n"
                f"Waktu: {now_wib}\n"
                f"Status: {status_text}\n"
                f"Hubungi teknisi dan kepala perawat segera."
            )
            send_telegram(tg_token, tg_direktur, msg)

def check_offline_sensors():
    """
    Check if any registered sensor hasn't sent data in >5 minutes.
    If offline, send Level 3 alert to Telegram Direktur.
    Called from /api/sensor-status endpoint.
    """
    _load_states()
    now = datetime.now(timezone.utc)
    
    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    tg_direktur = os.environ.get("TELEGRAM_CHAT_ID_DIREKTUR")
    
    if not tg_token or not tg_direktur:
        logger.warning("Telegram Direktur config missing, skip offline check")
        return

    # We need access to the telemetry buffer from app.py
    # Instead, we track last_seen per device in _alert_states
    for device_id, room in ROOM_CONFIG.items():
        state = _alert_states.get(device_id, {})
        last_seen_str = state.get("last_data_at")
        
        if not last_seen_str:
            # Never received data — don't spam, just skip
            continue
        
        try:
            last_seen = datetime.fromisoformat(last_seen_str)
        except (ValueError, TypeError):
            continue
        
        diff_seconds = (now - last_seen).total_seconds()
        already_notified = state.get("offline_notified", False)
        
        # Sensor offline > 5 minutes and not yet notified
        if diff_seconds > 300 and not already_notified:
            now_wib = datetime.now(WIB).strftime("%H:%M:%S WIB")
            last_wib = last_seen.astimezone(WIB).strftime("%H:%M:%S WIB")
            offline_mins = int(diff_seconds / 60)
            
            msg = (
                f"🔴 <b>SENSOR OFFLINE</b> — {room['name']}\n"
                f"⚠️ <b>Sensor tidak mengirim data > {offline_mins} menit</b>\n"
                f"Device: {device_id}\n"
                f"Data terakhir: {last_wib}\n"
                f"Waktu deteksi: {now_wib}\n"
                f"Periksa koneksi sensor dan WiFi segera."
            )
            send_telegram(tg_token, tg_direktur, msg)
            logger.info(f"Offline alert sent for {device_id} to Direktur")
            
            state["offline_notified"] = True
            _alert_states[device_id] = state
            _save_state(device_id, state)
        
        # Sensor back online — reset offline flag
        elif diff_seconds <= 300 and already_notified:
            now_wib = datetime.now(WIB).strftime("%H:%M:%S WIB")
            msg = (
                f"✅ <b>SENSOR ONLINE</b> — {room['name']}\n"
                f"Sensor {device_id} kembali aktif.\n"
                f"Waktu: {now_wib}"
            )
            send_telegram(tg_token, tg_direktur, msg)
            logger.info(f"Online recovery sent for {device_id} to Direktur")
            
            state["offline_notified"] = False
            _alert_states[device_id] = state
            _save_state(device_id, state)


def update_last_seen(device_id: str):
    """Called from app.py on every telemetry POST to track when sensor last sent data."""
    _load_states()
    now = datetime.now(timezone.utc)
    state = _alert_states.get(device_id, {})
    state["last_data_at"] = now.isoformat()
    state["offline_notified"] = False  # Reset offline flag on every data received
    _alert_states[device_id] = state
    _save_state(device_id, state)
