"""
services/notifier.py
State-based Discord alerting service with anti-rate-limit state machine.
Alert states are persisted in Firestore to survive function cold starts.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
import requests
from firebase_admin import firestore

logger = logging.getLogger(__name__)

# Alert state constants
STATE_NORMAL = "normal"
STATE_CRITICAL = "critical"
STATE_CRITICAL_REMINDED = "critical_reminded"

# Thresholds
CRITICAL_TEMP_THRESHOLD = 32.0
REMINDER_COOLDOWN_MINUTES = 5


def _get_state_doc():
    """Retrieve the alert state document from Firestore."""
    db = firestore.client()
    return db.collection("_system").document("alert_state")


def _get_current_state() -> dict:
    """Read current alert state from Firestore."""
    doc = _get_state_doc().get()
    if doc.exists:
        return doc.to_dict()
    return {
        "state": STATE_NORMAL,
        "last_alert_sent_at": None,
        "entered_critical_at": None,
    }


def _save_state(state_data: dict):
    """Persist alert state to Firestore."""
    _get_state_doc().set(state_data)


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
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
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
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
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
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
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
    Main state machine entry point. Evaluates incoming sensor data against
    the persisted alert state and sends Discord notifications as appropriate.

    State transitions:
      normal -> critical         : Send critical alert immediately
      critical -> critical       : Send reminder if >= REMINDER_COOLDOWN_MINUTES have elapsed
      critical/reminded -> normal: Send resolved alert
    """
    now = datetime.now(timezone.utc)
    current = _get_current_state()
    current_state = current.get("state", STATE_NORMAL)
    last_alert_sent_at: Optional[datetime] = current.get("last_alert_sent_at")

    if isinstance(last_alert_sent_at, str):
        last_alert_sent_at = datetime.fromisoformat(last_alert_sent_at)

    is_critical = temperature >= CRITICAL_TEMP_THRESHOLD

    if is_critical:
        if current_state == STATE_NORMAL:
            # Transition: normal → critical. Send immediate alert.
            embed = _build_critical_embed(temperature, humidity, device_id)
            _send_discord_embed(webhook_url, embed)
            _save_state({
                "state": STATE_CRITICAL,
                "last_alert_sent_at": now.isoformat(),
                "entered_critical_at": now.isoformat(),
            })
            logger.info("State: normal → critical. Critical alert dispatched.")

        elif current_state in (STATE_CRITICAL, STATE_CRITICAL_REMINDED):
            # Still critical — check if reminder cooldown has elapsed
            if last_alert_sent_at is not None:
                elapsed = now - last_alert_sent_at
                if elapsed >= timedelta(minutes=REMINDER_COOLDOWN_MINUTES):
                    embed = _build_reminder_embed(temperature, humidity, device_id)
                    _send_discord_embed(webhook_url, embed)
                    _save_state({
                        "state": STATE_CRITICAL_REMINDED,
                        "last_alert_sent_at": now.isoformat(),
                        "entered_critical_at": current.get("entered_critical_at", now.isoformat()),
                    })
                    logger.info("Reminder sent. Elapsed: %s", elapsed)
                else:
                    logger.info(
                        "Still critical but within cooldown window. Elapsed: %s / %s min",
                        elapsed.total_seconds() / 60,
                        REMINDER_COOLDOWN_MINUTES,
                    )
    else:
        # Temperature is normal
        if current_state in (STATE_CRITICAL, STATE_CRITICAL_REMINDED):
            # Transition: critical → normal. Send resolved alert.
            embed = _build_resolved_embed(temperature, humidity, device_id)
            _send_discord_embed(webhook_url, embed)
            _save_state({
                "state": STATE_NORMAL,
                "last_alert_sent_at": now.isoformat(),
                "entered_critical_at": None,
            })
            logger.info("State: critical → normal. Resolved alert dispatched.")
        else:
            logger.debug("State remains normal. No action needed.")
