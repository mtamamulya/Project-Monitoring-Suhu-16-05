"""
routes/verification.py — Verifikasi manual shift (Pagi/Siang/Malam) + tanda tangan
digital. Digitalisasi formulir pencatatan suhu/kelembaban manual RSND yang mengikuti
Permenkes RI No. 72 Tahun 2016 (cek 3x/hari: 07:00, 14:00, 22:00).

Tetap pakai 1 akun login bersama (sesuai sistem existing) — sebelum submit, user
memilih nama verifikator dari daftar terdaftar (services/config.py) dan menandatangani
lewat signature pad di frontend (dikirim sebagai base64 PNG data URL).
"""

import logging
from datetime import datetime, timezone

from services.config import ROOM_CONFIG, VERIFIKATOR_LIST

logger = logging.getLogger(__name__)

VALID_SHIFTS = {"Pagi", "Siang", "Malam"}


def submit_verification(db, device_id: str, shift: str, verifikator_id: str,
                         temperature, humidity, signature: str,
                         catatan: str = "", tindakan: str = "") -> dict:
    """Simpan 1 entri verifikasi shift. Melempar ValueError kalau input tidak valid."""
    if db is None:
        raise RuntimeError("Database not connected")
    if device_id not in ROOM_CONFIG:
        raise ValueError("Ruangan tidak ditemukan")
    if shift not in VALID_SHIFTS:
        raise ValueError("Shift harus salah satu dari: Pagi, Siang, Malam")

    verifikator = next((v for v in VERIFIKATOR_LIST if v["id"] == verifikator_id), None)
    if not verifikator:
        raise ValueError("Verifikator tidak ditemukan — pilih dari daftar terdaftar")

    if temperature is None or humidity is None:
        raise ValueError("temperature dan humidity wajib diisi")
    try:
        temperature = float(temperature)
        humidity = float(humidity)
    except (TypeError, ValueError) as exc:
        raise ValueError("temperature/humidity harus angka") from exc

    if not signature or not isinstance(signature, str) or len(signature) < 50:
        raise ValueError("Tanda tangan digital wajib diisi")

    room = ROOM_CONFIG[device_id]
    in_range = (room["tempMin"] <= temperature <= room["tempMax"]) and (room["humMin"] <= humidity <= room["humMax"])

    now = datetime.now(timezone.utc)
    doc = {
        "device_id":        device_id,
        "room_name":        room["name"],
        "shift":            shift,
        "verifikator_id":   verifikator_id,
        "verifikator_name": verifikator["name"],
        "temperature":      temperature,
        "humidity":         humidity,
        "in_range":         in_range,
        "signature":        signature,   # base64 PNG data URL dari signature pad frontend
        "catatan":          (catatan or "").strip(),
        "tindakan":         (tindakan or "").strip(),
        "submitted_at":     now,
    }

    _, doc_ref = db.collection("verifications").add(doc)
    out = dict(doc)
    out["id"] = doc_ref.id
    out["submitted_at"] = now.isoformat()
    return out


def get_verifications(db, device_id: str, year: int, month: int) -> list:
    """Semua entri verifikasi 1 ruangan untuk 1 bulan tertentu, urut waktu naik — untuk halaman Kepatuhan/Rekap Bulanan."""
    if db is None:
        return []
    if device_id not in ROOM_CONFIG:
        raise ValueError("Ruangan tidak ditemukan")

    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)

    query = (
        db.collection("verifications")
        .where("device_id", "==", device_id)
        .where("submitted_at", ">=", start)
        .where("submitted_at", "<", end)
        .order_by("submitted_at", direction="ASCENDING")
    )

    results = []
    for d in query.stream():
        v = d.to_dict()
        ts = v.get("submitted_at")
        v["submitted_at"] = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        v["id"] = d.id
        results.append(v)
    return results
