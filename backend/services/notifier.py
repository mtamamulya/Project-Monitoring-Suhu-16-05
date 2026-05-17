"""
services/notifier.py
State-based Discord alerting service with anti-rate-limit state machine.
Alert state stored in MEMORY (with Firestore backup for persistence).
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
import requests

logger = logging.getLogger(__name__)

# Alert state constants
STATE_NORMAL = "normal"
STATE_CRITICAL = "critical"
STATE_CRITICAL_REMINDED = "critical_reminded"

# Thresholds
CRITICAL_TEMP_THRESHOLD = 32.0
REMINDER_COOLDOWN_MINUTES = 5

# In-memory alert state (no Firestore reads needed)
_alert_state = {
    "state": STATE_NORMAL,
    "last_alert_sent_at": None,
    "entered_critical_at": None,
}
_state_loaded = False


def _load_state_once():
    """Load state from Firestore once on first call, then use memory."""
    global _state_loaded
    if _state_loaded:
        return
    try:
        from firebase_admin import firestore as _fs
        db = _fs.client()
        doc = db.collection("_system").document("alert_state").get()
        if doc.exists:
            _alert_state.update(doc.to_dict())
            logger.info("Alert state loaded from Firestore: %s", _alert_state["state"])
    except Exception as exc:
        logger.warning("Could not load alert state from Firestore: %s", exc)
    _state_loaded = True


def _save_state_to_firestore(state_data: dict):
    """Best-effort persist state to Firestore (for cold start recovery)."""
    try:
        from firebase_admin import firestore as _fs
        db = _fs.client()
        db.collection("_system").document("alert_state").set(state_data)
    except Exception as exc:
        logger.warning("Could not save alert state to Firestore: %s", exc)


def _send_discord_embed(webhook_url: str, embed: dict):
    """Send a formatted embed to a Discord webhook."""
    payload = {"embeds": [embed]}
    try:
        resp = requests.post(webhook_url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info("Discord alert sent successfully, status=%s", resp.status_code)
    except requests.RequestException as exc:
        logger.error("Failed to send Discord alert: %s", exc)


def _build_critical_embed(temperature: float, humidity: float, device_id: str) -> dict:
    now_str = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S WIB")
    return {
        "title": "🚨 CRITICAL TEMPERATURE ALERT",
        "description": (
            f"**Device `{device_id}`** is reporting dangerously high temperature.\n"
            f"Immediate attention may be required."
        ),
        "color": 0xE53E3E,
        "fields": [
            {"name": "🌡️ Temperature", "value": f"**{temperature:.1f}°C**", "inline": True},
            {"name": "💧 Humidity", "value": f"**{humidity:.1f}%**", "inline": True},
            {"name": "⚠️ Threshold", "value": f"≥ {CRITICAL_TEMP_THRESHOLD}°C", "inline": True},
        ],
        "footer": {"text": f"Semarang Climate Monitor • {now_str}"},
        "thumbnail": {"url": "https://cdn-icons-png.flaticon.com/512/1684/1684375.png"},
    }


def _build_reminder_embed(temperature: float, humidity: float, device_id: str) -> dict:
    now_str = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S WIB")
    return {
        "title": "🔁 TEMPERATURE STILL CRITICAL — Reminder",
        "description": (
            f"**Device `{device_id}`** remains above the critical threshold.\n"
            f"Temperature has **not resolved** after {REMINDER_COOLDOWN_MINUTES}+ minutes."
        ),
        "color": 0xDD6B20,
        "fields": [
            {"name": "🌡️ Temperature", "value": f"**{temperature:.1f}°C**", "inline": True},
            {"name": "💧 Humidity", "value": f"**{humidity:.1f}%**", "inline": True},
        ],
        "footer": {"text": f"Semarang Climate Monitor • {now_str}"},
    }


def _build_resolved_embed(temperature: float, humidity: float, device_id: str) -> dict:
    now_str = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S WIB")
    return {
        "title": "✅ TEMPERATURE RESOLVED",
        "description": (
            f"**Device `{device_id}`** has returned to normal operating range.\n"
            f"No further action required."
        ),
        "color": 0x38A169,
        "fields": [
            {"name": "🌡️ Temperature", "value": f"**{temperature:.1f}°C**", "inline": True},
            {"name": "💧 Humidity", "value": f"**{humidity:.1f}%**", "inline": True},
            {"name": "✔️ Status", "value": "Normal", "inline": True},
        ],
        "footer": {"text": f"Semarang Climate Monitor • {now_str}"},
    }


def process_alert(
    temperature: float,
    humidity: float,
    device_id: str,
    webhook_url: str,
):
    """
    Main state machine entry point. Uses in-memory state to avoid
    Firestore reads on every call. State is backed up to Firestore
    only when transitions happen (rare).

    State transitions:
      normal -> critical         : Send critical alert immediately
      critical -> critical       : Send reminder if >= REMINDER_COOLDOWN_MINUTES
      critical/reminded -> normal: Send resolved alert
    """
    # Load state from Firestore once (on cold start)
    _load_state_once()

    now = datetime.now(timezone.utc)
    current_state = _alert_state.get("state", STATE_NORMAL)
    last_alert_sent_at: Optional[datetime] = _alert_state.get("last_alert_sent_at")

    if isinstance(last_alert_sent_at, str):
        last_alert_sent_at = datetime.fromisoformat(last_alert_sent_at)

    is_critical = temperature >= CRITICAL_TEMP_THRESHOLD

    if is_critical:
        if current_state == STATE_NORMAL:
            # Transition: normal → critical. Send immediate alert.
            embed = _build_critical_embed(temperature, humidity, device_id)
            _send_discord_embed(webhook_url, embed)
            new_state = {
                "state": STATE_CRITICAL,
                "last_alert_sent_at": now.isoformat(),
                "entered_critical_at": now.isoformat(),
            }
            _alert_state.update(new_state)
            _save_state_to_firestore(new_state)
            logger.info("State: normal → critical. Critical alert dispatched.")

        elif current_state in (STATE_CRITICAL, STATE_CRITICAL_REMINDED):
            # Still critical — check if reminder cooldown has elapsed
            if last_alert_sent_at is not None:
                elapsed = now - last_alert_sent_at
                if elapsed >= timedelta(minutes=REMINDER_COOLDOWN_MINUTES):
                    embed = _build_reminder_embed(temperature, humidity, device_id)
                    _send_discord_embed(webhook_url, embed)
                    new_state = {
                        "state": STATE_CRITICAL_REMINDED,
                        "last_alert_sent_at": now.isoformat(),
                        "entered_critical_at": _alert_state.get("entered_critical_at", now.isoformat()),
                    }
                    _alert_state.update(new_state)
                    _save_state_to_firestore(new_state)
                    logger.info("Reminder sent. Elapsed: %s", elapsed)
                else:
                    logger.debug(
                        "Still critical but within cooldown window. Elapsed: %.1f / %s min",
                        elapsed.total_seconds() / 60,
                        REMINDER_COOLDOWN_MINUTES,
                    )
    else:
        # Temperature is normal
        if current_state in (STATE_CRITICAL, STATE_CRITICAL_REMINDED):
            # Transition: critical → normal. Send resolved alert.
            embed = _build_resolved_embed(temperature, humidity, device_id)
            _send_discord_embed(webhook_url, embed)
            new_state = {
                "state": STATE_NORMAL,
                "last_alert_sent_at": now.isoformat(),
                "entered_critical_at": None,
            }
            _alert_state.update(new_state)
            _save_state_to_firestore(new_state)
            logger.info("State: critical → normal. Resolved alert dispatched.")
        else:
            logger.debug("State remains normal. No action needed.")
