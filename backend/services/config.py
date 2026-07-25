"""
services/config.py — Dynamic system configuration (Firestore-backed)

Menggantikan ROOM_CONFIG yang dulu hardcoded di services/notifier.py.
Dimuat sekali saat startup (load_config), disimpan di memory sebagai
single source of truth yang dipakai bareng oleh notifier / routes/ai /
routes/analytics / app.py, dan diperbarui lewat endpoint admin
(routes/admin.py). Setiap perubahan threshold ruangan atau daftar
verifikator dicatat ke audit log Firestore (_audit_log).

PENTING: ROOM_CONFIG & VERIFIKATOR_LIST diupdate IN-PLACE (.clear()/.update()/
append), bukan di-reassign — supaya module lain yang sudah
`from services.notifier import ROOM_CONFIG` tetap mengacu ke dict/list yang
sama dan otomatis lihat perubahan terbaru.
"""

import logging
import threading
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_loaded = False

# Dipakai untuk seed Firestore pertama kali — 6 ruangan RSND menggantikan
# konfigurasi lama (NICU-01, BANGSAL-A, BANGSAL-B, ISOLASI-01).
# Threshold mengikuti Permenkes RI No. 72 Tahun 2016 (15-25C, 45-55%) sesuai
# formulir pencatatan manual RSND.
#  tempOffset/humOffset: koreksi kalibrasi per unit sensor (derajat/%RH),
#  ditambahkan ke pembacaan mentah di app.py SEBELUM disimpan/dievaluasi —
#  supaya kalibrasi bisa dikoreksi kapan saja lewat endpoint admin tanpa
#  reflash firmware (lihat catatan KALIBRASI SENSOR di climateos_esp32.ino).
DEFAULT_ROOM_CONFIG = {
    "BERSALIN-01":     {"name": "Ruang Bersalin 1",   "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
    "BERSALIN-02":     {"name": "Ruang Bersalin 2",   "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
    "OBAT-01":         {"name": "Ruang Obat",         "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
    "PERINATOLOGI-01": {"name": "Ruang Perinatologi", "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
    "RAWATINAP-01":    {"name": "Ruang Rawat Inap 1", "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
    "NURSESTATION-01": {"name": "Nurse Station",      "floor": "", "tempMin": 15.0, "tempMax": 25.0, "humMin": 45.0, "humMax": 55.0, "tempOffset": 0.0, "humOffset": 0.0},
}

ROOM_CONFIG = dict(DEFAULT_ROOM_CONFIG)   # in-memory cache — mutable in place
VERIFIKATOR_LIST = []                     # [{"id": doc_id, "name": "..."}]

ALLOWED_THRESHOLD_KEYS = {"tempMin", "tempMax", "humMin", "humMax", "name", "floor", "tempOffset", "humOffset"}


def _room_config_doc(db):
    return db.collection("_system").document("room_config")


def load_config(db) -> None:
    """Load room config & daftar verifikator dari Firestore ke memory. Sekali saat startup (idempotent)."""
    global _loaded
    if _loaded or db is None:
        return
    with _lock:
        try:
            doc = _room_config_doc(db).get()
            if doc.exists and doc.to_dict().get("rooms"):
                ROOM_CONFIG.clear()
                ROOM_CONFIG.update(doc.to_dict()["rooms"])
                logger.info("Room config dimuat dari Firestore (%d ruangan).", len(ROOM_CONFIG))
            else:
                _room_config_doc(db).set({"rooms": DEFAULT_ROOM_CONFIG})
                logger.info("Room config belum ada di Firestore — seed dengan default (6 ruangan RSND).")
        except Exception as exc:
            logger.error("Gagal load room config dari Firestore, pakai default in-memory: %s", exc)

        try:
            docs = db.collection("verifikators").order_by("name").stream()
            VERIFIKATOR_LIST.clear()
            for d in docs:
                v = d.to_dict()
                VERIFIKATOR_LIST.append({"id": d.id, "name": v.get("name", "")})
            logger.info("Daftar verifikator dimuat (%d orang).", len(VERIFIKATOR_LIST))
        except Exception as exc:
            logger.error("Gagal load daftar verifikator dari Firestore: %s", exc)

        _loaded = True


def _write_audit(db, action: str, detail: dict, changed_by: str) -> None:
    if db is None:
        return
    try:
        db.collection("_audit_log").add({
            "action":     action,
            "detail":     detail,
            "changed_by": changed_by or "unknown",
            "timestamp":  datetime.now(timezone.utc),
        })
    except Exception as exc:
        logger.warning("Gagal tulis audit log: %s", exc)


def update_room_threshold(db, device_id: str, updates: dict, changed_by: str) -> dict:
    """
    Update sebagian field ruangan (threshold suhu/kelembaban, nama, lantai).
    updates: subset dari {tempMin, tempMax, humMin, humMax, name, floor}.
    Mengembalikan config ruangan setelah diupdate. Melempar ValueError kalau invalid.
    """
    if device_id not in ROOM_CONFIG:
        raise ValueError(f"Ruangan '{device_id}' tidak ditemukan")

    clean_updates = {k: v for k, v in (updates or {}).items() if k in ALLOWED_THRESHOLD_KEYS}
    if not clean_updates:
        raise ValueError("Tidak ada field valid untuk diupdate")

    # Offset kalibrasi dibatasi ±10 — di luar itu hampir pasti salah ketik, dan
    # offset ekstrem bisa menyembunyikan sensor rusak (pembacaan ngawur jadi
    # "terlihat normal" setelah dikoreksi). Lebih baik ditolak.
    for off_key in ("tempOffset", "humOffset"):
        if off_key in clean_updates:
            try:
                val = float(clean_updates[off_key])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{off_key} harus angka") from exc
            if not (-10.0 <= val <= 10.0):
                raise ValueError(f"{off_key} harus antara -10 dan 10")
            clean_updates[off_key] = val

    # Validasi numerik dasar supaya tidak kesimpan config rusak (mis. min > max)
    merged = {**ROOM_CONFIG[device_id], **clean_updates}
    for lo, hi in (("tempMin", "tempMax"), ("humMin", "humMax")):
        if lo in merged and hi in merged:
            try:
                if float(merged[lo]) >= float(merged[hi]):
                    raise ValueError(f"{lo} harus lebih kecil dari {hi}")
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Nilai {lo}/{hi} tidak valid: {exc}") from exc

    old_values = {k: ROOM_CONFIG[device_id].get(k) for k in clean_updates}

    with _lock:
        ROOM_CONFIG[device_id].update(clean_updates)
        if db is not None:
            _room_config_doc(db).set({"rooms": ROOM_CONFIG})

    _write_audit(db, "update_room_threshold", {
        "device_id": device_id,
        "room_name": ROOM_CONFIG[device_id].get("name", device_id),
        "old": old_values,
        "new": clean_updates,
    }, changed_by)

    return dict(ROOM_CONFIG[device_id])


def add_verifikator(db, name: str, added_by: str) -> dict:
    """Tambah nama verifikator baru ke daftar (dipakai dropdown saat submit verifikasi shift)."""
    name = (name or "").strip()
    if not name:
        raise ValueError("Nama verifikator tidak boleh kosong")
    if db is None:
        raise RuntimeError("Database not connected")

    # Cegah duplikat nama (case-insensitive)
    if any(v["name"].strip().lower() == name.lower() for v in VERIFIKATOR_LIST):
        raise ValueError(f"Verifikator dengan nama '{name}' sudah ada")

    doc_ref = db.collection("verifikators").document()
    doc_ref.set({"name": name, "created_at": datetime.now(timezone.utc)})
    entry = {"id": doc_ref.id, "name": name}

    with _lock:
        VERIFIKATOR_LIST.append(entry)
        VERIFIKATOR_LIST.sort(key=lambda v: v["name"])

    _write_audit(db, "add_verifikator", {"name": name}, added_by)
    return entry


def remove_verifikator(db, verifikator_id: str, removed_by: str) -> None:
    """Hapus nama verifikator dari daftar. Tidak menghapus entri verifikasi historis yang sudah pakai nama ini."""
    if db is None:
        raise RuntimeError("Database not connected")

    match = next((v for v in VERIFIKATOR_LIST if v["id"] == verifikator_id), None)
    if not match:
        raise ValueError("Verifikator tidak ditemukan")

    db.collection("verifikators").document(verifikator_id).delete()
    with _lock:
        VERIFIKATOR_LIST[:] = [v for v in VERIFIKATOR_LIST if v["id"] != verifikator_id]

    _write_audit(db, "remove_verifikator", {"name": match["name"]}, removed_by)


def get_audit_log(db, limit: int = 50) -> list:
    """Ambil riwayat perubahan threshold/verifikator terbaru, untuk halaman admin."""
    if db is None:
        return []
    try:
        docs = (
            db.collection("_audit_log")
            .order_by("timestamp", direction="DESCENDING")
            .limit(limit)
            .stream()
        )
        result = []
        for d in docs:
            v = d.to_dict()
            ts = v.get("timestamp")
            result.append({
                "action":     v.get("action"),
                "detail":     v.get("detail"),
                "changed_by": v.get("changed_by"),
                "timestamp":  ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
            })
        return result
    except Exception as exc:
        logger.error("Gagal ambil audit log: %s", exc)
        return []
