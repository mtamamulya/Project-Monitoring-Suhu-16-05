"""
services/buffer.py — In-Memory Telemetry Buffer (Centralized)

Modul ini adalah satu-satunya tempat state buffer disimpan.
Semua modul lain (app.py, routes/ai.py) harus import dari sini.
Ini menghilangkan circular import antara app.py dan routes/ai.py.
"""

import logging
import threading
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

# ── State ─────────────────────────────────────────────────────
_buffer_lock = threading.Lock()
_telemetry_buffer: list = []        # List[dict], sorted by timestamp ASC
MAX_BUFFER_SIZE   = 5760            # 24 jam @ 15 detik interval
_buffer_bootstrapped = False


# ── Bootstrap ─────────────────────────────────────────────────

def bootstrap_buffer(db) -> None:
    """
    Load data 24 jam terakhir dari Firestore ke memory saat cold start.
    Hanya berjalan sekali — berikutnya di-skip.
    """
    global _buffer_bootstrapped
    if _buffer_bootstrapped or db is None:
        return

    try:
        from firebase_admin import firestore as fs
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        query = (
            db.collection("telemetry")
            .where("timestamp", ">=", cutoff)
            .order_by("timestamp", direction=fs.Query.ASCENDING)
            .limit(MAX_BUFFER_SIZE)
        )
        docs = list(query.stream())
        with _buffer_lock:
            for doc in docs:
                d = doc.to_dict()
                _telemetry_buffer.append({
                    "temperature": d.get("temperature"),
                    "humidity":    d.get("humidity"),
                    "device_id":   d.get("device_id"),
                    "timestamp":   d.get("timestamp"),
                })
        logger.info("Buffer bootstrapped dengan %d records dari Firestore.", len(docs))
    except Exception as exc:
        logger.error("Buffer bootstrap gagal: %s", exc)
    finally:
        _buffer_bootstrapped = True


# ── Write ──────────────────────────────────────────────────────

def add_to_buffer(record: dict) -> None:
    """Tambah satu record baru ke buffer, trim jika melebihi MAX_BUFFER_SIZE."""
    with _buffer_lock:
        _telemetry_buffer.append(record)
        while len(_telemetry_buffer) > MAX_BUFFER_SIZE:
            _telemetry_buffer.pop(0)


# ── Read ───────────────────────────────────────────────────────

def get_buffer_since(cutoff_dt) -> list:
    """Return semua record sejak cutoff_dt (timezone-aware datetime)."""
    with _buffer_lock:
        return [
            r for r in _telemetry_buffer
            if r.get("timestamp") and r["timestamp"] >= cutoff_dt
        ]


def get_latest(device_id: str = None) -> dict | None:
    """
    Return record paling baru.
    Jika device_id diberikan, cari record terbaru untuk device itu saja.
    """
    with _buffer_lock:
        if not _telemetry_buffer:
            return None
        if device_id is None:
            return _telemetry_buffer[-1].copy()
        for r in reversed(_telemetry_buffer):
            if r.get("device_id") == device_id:
                return r.copy()
    return None


def get_all_latest() -> dict:
    """
    Return dict {device_id: record} berisi record terbaru per device.
    Berguna untuk sensor-status endpoint.
    """
    result = {}
    with _buffer_lock:
        for r in reversed(_telemetry_buffer):
            did = r.get("device_id")
            if did and did not in result:
                result[did] = r.copy()
    return result


def get_buffer_snapshot() -> list:
    """Return salinan penuh buffer (untuk AI context). Terbaru di akhir."""
    with _buffer_lock:
        return list(_telemetry_buffer)


def get_buffer_size() -> int:
    """Return jumlah record saat ini di buffer."""
    with _buffer_lock:
        return len(_telemetry_buffer)
