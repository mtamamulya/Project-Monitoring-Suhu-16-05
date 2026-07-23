"""
routes/admin.py — Endpoint admin: threshold ruangan, daftar verifikator, audit log.
Dipanggil dari app.py (pola sama dengan routes/ai.py, routes/analytics.py) — logic
inti (validasi, persist ke Firestore, tulis audit log) ada di services/config.py.
"""

import logging

from services import config as config_service
from services.config import ROOM_CONFIG, VERIFIKATOR_LIST

logger = logging.getLogger(__name__)


def list_rooms() -> list:
    """Daftar ruangan + threshold saat ini, untuk halaman setting admin."""
    return [{"id": device_id, **cfg} for device_id, cfg in ROOM_CONFIG.items()]


def update_room(db, device_id: str, updates: dict, changed_by: str) -> dict:
    """Update threshold/nama satu ruangan. Melempar ValueError kalau input invalid."""
    return config_service.update_room_threshold(db, device_id, updates, changed_by)


def list_verifikators() -> list:
    """Daftar nama verifikator terdaftar, untuk dropdown saat submit verifikasi shift."""
    return list(VERIFIKATOR_LIST)


def create_verifikator(db, name: str, added_by: str) -> dict:
    return config_service.add_verifikator(db, name, added_by)


def delete_verifikator(db, verifikator_id: str, removed_by: str) -> None:
    config_service.remove_verifikator(db, verifikator_id, removed_by)


def get_audit_log(db, limit: int = 50) -> list:
    """Riwayat perubahan threshold/verifikator terbaru — siapa mengubah apa, kapan."""
    return config_service.get_audit_log(db, limit)
