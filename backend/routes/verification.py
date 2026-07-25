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
from services.timeutil import month_bounds_utc

logger = logging.getLogger(__name__)

VALID_SHIFTS = {"Pagi", "Siang", "Malam"}


def submit_verification(db, device_id: str, shift: str, verifikator_id: str,
                         temperature, humidity, signature: str,
                         catatan: str = "", tindakan: str = "",
                         submitted_by: str = "") -> dict:
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
        # Akun yang dipakai saat submit (dari token Firebase yang diverifikasi).
        # Berbeda dari verifikator_name: sistem ini memakai 1 akun bersama, jadi
        # 'siapa yang mengetik' dan 'siapa yang bertanggung jawab klinis' dicatat
        # terpisah. Penting untuk telusur audit kalau ada entri dipertanyakan.
        "submitted_by":     (submitted_by or "").strip(),
        # Penanda koreksi — diisi kalau entri ini kemudian diralat.
        "corrected":        False,
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

    # Batas bulan dihitung dalam WIB, bukan UTC — lihat catatan di month_bounds_utc().
    start, end = month_bounds_utc(year, month)

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
        cts = v.get("corrected_at")
        if cts is not None:
            v["corrected_at"] = cts.isoformat() if hasattr(cts, "isoformat") else str(cts)
        v["id"] = d.id
        results.append(v)
    return results


def correct_verification(db, verification_id: str, temperature, humidity,
                          alasan: str, corrected_by: str, verifikator_id: str = "",
                          signature: str = "") -> dict:
    """
    Ralat entri verifikasi yang salah input.

    KENAPA TIDAK MENIMPA / MENGHAPUS
    Ini dokumen bukti akreditasi. Standar pencatatan medis (dan kebiasaan pada
    formulir kertas) adalah: nilai keliru TIDAK dihapus, tapi dicoret dan ditulis
    ulang di sebelahnya, disertai alasan dan paraf. Kalau nilai lama hilang tanpa
    jejak, auditor tidak bisa membedakan "koreksi jujur" dari "pemalsuan data".

    Karena itu di sini nilai lama disimpan di dalam dokumen yang sama (field
    original_*), entri ditandai corrected=True, dan alasan + pelaku + waktu
    koreksi dicatat. Frontend menampilkan nilai lama dicoret di samping nilai baru.

    Koreksi hanya boleh sekali — mengoreksi hasil koreksi akan mengaburkan mana
    nilai asli, jadi ditolak.
    """
    if db is None:
        raise RuntimeError("Database not connected")

    alasan = (alasan or "").strip()
    if len(alasan) < 5:
        raise ValueError("Alasan koreksi wajib diisi (minimal 5 karakter)")

    doc_ref = db.collection("verifications").document(verification_id)
    snap = doc_ref.get()
    if not snap.exists:
        raise ValueError("Entri verifikasi tidak ditemukan")

    existing = snap.to_dict()
    if existing.get("corrected"):
        raise ValueError(
            "Entri ini sudah pernah dikoreksi dan tidak bisa dikoreksi lagi. "
            "Kalau masih keliru, buat entri verifikasi baru dan jelaskan di catatan."
        )

    try:
        temperature = float(temperature)
        humidity = float(humidity)
    except (TypeError, ValueError) as exc:
        raise ValueError("temperature/humidity harus angka") from exc
    if not (-50 <= temperature <= 100):
        raise ValueError("temperature di luar rentang wajar (-50 s/d 100)")
    if not (0 <= humidity <= 100):
        raise ValueError("humidity harus antara 0 dan 100")

    device_id = existing.get("device_id")
    room = ROOM_CONFIG.get(device_id)
    if not room:
        raise ValueError("Ruangan entri ini sudah tidak terdaftar")
    in_range = (room["tempMin"] <= temperature <= room["tempMax"]) and \
               (room["humMin"] <= humidity <= room["humMax"])

    updates = {
        # Simpan nilai asli — inilah yang membuat koreksi bisa diaudit.
        "original_temperature": existing.get("temperature"),
        "original_humidity":    existing.get("humidity"),
        "original_in_range":    existing.get("in_range"),
        "temperature":          temperature,
        "humidity":             humidity,
        "in_range":             in_range,
        "corrected":            True,
        "corrected_at":         datetime.now(timezone.utc),
        "corrected_by":         (corrected_by or "unknown").strip(),
        "correction_reason":    alasan,
    }

    # Verifikator boleh diganti kalau ternyata salah pilih nama; kalau diganti,
    # tanda tangan baru wajib ikut supaya pertanggungjawaban tetap sah.
    if verifikator_id:
        verifikator = next((v for v in VERIFIKATOR_LIST if v["id"] == verifikator_id), None)
        if not verifikator:
            raise ValueError("Verifikator tidak ditemukan — pilih dari daftar terdaftar")
        if not signature or len(signature) < 50:
            raise ValueError("Mengganti verifikator wajib disertai tanda tangan baru")
        updates["original_verifikator_name"] = existing.get("verifikator_name")
        updates["verifikator_id"]   = verifikator_id
        updates["verifikator_name"] = verifikator["name"]
        updates["signature"]        = signature

    doc_ref.update(updates)

    merged = {**existing, **updates, "id": verification_id}
    for key in ("submitted_at", "corrected_at"):
        val = merged.get(key)
        if hasattr(val, "isoformat"):
            merged[key] = val.isoformat()
    return merged
