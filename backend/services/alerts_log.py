"""
services/alerts_log.py — Riwayat alert (in-memory + Firestore)

Dipakai untuk notification bell di website (badge count + dropdown riwayat)
dan sebagai jejak audit tambahan untuk tim teknisi. Mengikuti pola yang sama
dengan services/buffer.py: baca dari memory (instan, tanpa baca Firestore
berulang tiap bell di-poll), tulis ke Firestore supaya persist & bisa
di-bootstrap ulang saat cold start.
"""

import logging
import threading
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_alerts: list = []
MAX_ALERTS = 200
_bootstrapped = False


def bootstrap_alerts(db) -> None:
    """Load beberapa hari alert terakhir dari Firestore ke memory saat cold start."""
    global _bootstrapped
    if _bootstrapped or db is None:
        return
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=3)
        docs = (
            db.collection("alerts_log")
            .where("timestamp", ">=", cutoff)
            .order_by("timestamp", direction="ASCENDING")
            .limit(MAX_ALERTS)
            .stream()
        )
        with _lock:
            for d in docs:
                _alerts.append(d.to_dict())
        logger.info("Alert log bootstrapped dengan %d entri.", len(_alerts))
    except Exception as exc:
        logger.error("Gagal bootstrap alert log: %s", exc)
    finally:
        _bootstrapped = True


def add_alert(db, device_id: str, room_name: str, level: int, level_label: str, message: str,
              temperature: float = None, humidity: float = None) -> None:
    """Catat 1 event alert (WARNING/CRITICAL/EMERGENCY/RESOLVED/OFFLINE/ONLINE)."""
    record = {
        "device_id":   device_id,
        "room_name":   room_name,
        "level":       level,
        "level_label": level_label,
        "message":     message,
        "temperature": temperature,
        "humidity":    humidity,
        "timestamp":   datetime.now(timezone.utc),
    }
    with _lock:
        _alerts.append(record)
        while len(_alerts) > MAX_ALERTS:
            _alerts.pop(0)

    if db is not None:
        try:
            db.collection("alerts_log").add(record)
        except Exception as exc:
            logger.warning("Gagal simpan alert log ke Firestore: %s", exc)


def get_recent_alerts(limit: int = 20) -> list:
    """Alert terbaru dulu (untuk dropdown bell). Timestamp sudah di-serialize jadi string ISO."""
    with _lock:
        recent = list(reversed(_alerts[-limit:]))
    out = []
    for r in recent:
        rc = dict(r)
        ts = rc.get("timestamp")
        rc["timestamp"] = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        out.append(rc)
    return out
