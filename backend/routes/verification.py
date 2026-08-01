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
from services.timeutil import month_bounds_utc, day_bounds_utc, WIB

logger = logging.getLogger(__name__)


class DuplicateShiftError(ValueError):
    """
    Shift yang sama untuk ruangan & hari yang sama sudah pernah diisi.
    Membawa id entri yang sudah ada supaya frontend bisa langsung menawarkan
    "buka ralat entri itu" alih-alih sekadar menampilkan pesan gagal.
    """
    def __init__(self, message, existing_id=None):
        super().__init__(message)
        self.existing_id = existing_id


class ImplausibleValueError(ValueError):
    """Nilai di luar batas kewajaran fisik — kemungkinan besar salah ketik."""
    pass

VALID_SHIFTS = {"Pagi", "Siang", "Malam"}

# Batas kewajaran fisik untuk ruangan rumah sakit ber-AC. Nilai di luar ini
# hampir pasti salah ketik (mis. 3°C padahal maksud 23°C, atau 445% kelembapan).
# Ini SENGAJA jauh lebih longgar daripada threshold Permenkes: tugasnya bukan
# menilai kepatuhan, tapi menangkap jari yang salah pencet. Deviasi asli seperti
# AC mati (30°C) harus tetap bisa dicatat apa adanya.
SANITY_TEMP_MIN, SANITY_TEMP_MAX = 5.0, 45.0
SANITY_HUM_MIN,  SANITY_HUM_MAX  = 10.0, 100.0


def evaluate_ranges(room: dict, temperature: float, humidity: float) -> dict:
    """
    Nilai suhu dan kelembapan SECARA TERPISAH.

    Kenapa terpisah: sebelumnya hanya ada satu penanda gabungan `in_range`, dan
    tampilan mewarnai kedua kolom memakai penanda itu. Akibatnya entri 23°C / 34%
    membuat kolom SUHU ikut merah, padahal 23°C masuk rentang 15-25 — yang
    melanggar cuma kelembapannya. Perawat jadi tidak tahu mana yang harus
    ditindak, dan auditor melihat pelanggaran suhu yang sebenarnya tidak ada.

    `in_range` gabungan tetap dihitung dan disimpan untuk kompatibilitas dengan
    data lama serta perhitungan skor kepatuhan.
    """
    temp_ok = room["tempMin"] <= temperature <= room["tempMax"]
    hum_ok  = room["humMin"]  <= humidity    <= room["humMax"]
    return {
        "temp_in_range": temp_ok,
        "hum_in_range":  hum_ok,
        "in_range":      temp_ok and hum_ok,
    }


def check_sanity(temperature: float, humidity: float) -> str:
    """
    Kembalikan pesan peringatan kalau nilai di luar batas kewajaran fisik,
    atau string kosong kalau wajar. Dipakai untuk MEMPERINGATKAN, bukan menolak —
    keputusan akhir tetap di tangan petugas yang melihat alat ukurnya langsung.
    """
    if not (SANITY_TEMP_MIN <= temperature <= SANITY_TEMP_MAX):
        return (f"Suhu {temperature}°C di luar batas kewajaran ruangan "
                f"({SANITY_TEMP_MIN:.0f}-{SANITY_TEMP_MAX:.0f}°C). Periksa lagi — kemungkinan salah ketik.")
    if not (SANITY_HUM_MIN <= humidity <= SANITY_HUM_MAX):
        return (f"Kelembapan {humidity}% di luar batas kewajaran "
                f"({SANITY_HUM_MIN:.0f}-{SANITY_HUM_MAX:.0f}%). Periksa lagi — kemungkinan salah ketik.")
    return ""


def find_existing_shift(db, device_id: str, shift: str, when=None):
    """
    Cari entri verifikasi yang SUDAH ADA untuk ruangan + shift + hari (WIB) yang sama.
    Return dict entri kalau ketemu, None kalau belum ada.
    """
    if db is None:
        return None
    ref = when or datetime.now(timezone.utc)
    ref_wib = ref.astimezone(WIB)
    start, end = day_bounds_utc(ref_wib.year, ref_wib.month, ref_wib.day)

    # Tanpa order_by — jadi query ini sudah tercakup composite index yang sama
    # dengan get_verifications (device_id + submitted_at). Tidak perlu index baru.
    # Filter shift dilakukan di Python karena jumlah dokumen per hari maksimal 3.
    query = (
        db.collection("verifications")
        .where("device_id", "==", device_id)
        .where("submitted_at", ">=", start)
        .where("submitted_at", "<", end)
    )
    for d in query.stream():
        v = d.to_dict()
        # device_id diperiksa ulang di sini, tidak hanya mengandalkan filter
        # Firestore. Kalau suatu saat query diubah/salah tulis, kesalahannya akan
        # berupa "duplikat tidak terdeteksi" — bukan "entri ruangan lain dianggap
        # duplikat", yang jauh lebih merusak karena memblokir pencatatan yang sah.
        if v.get("device_id") == device_id and v.get("shift") == shift:
            v["id"] = d.id
            return v
    return None


def submit_verification(db, device_id: str, shift: str, verifikator_id: str,
                         temperature, humidity, signature: str,
                         catatan: str = "", tindakan: str = "",
                         submitted_by: str = "", allow_extreme: bool = False,
                         sumber_nilai: str = "manual", sensor_waktu=None) -> dict:
    """
    Simpan 1 entri verifikasi shift. Melempar ValueError kalau input tidak valid.

    sumber_nilai: "sensor" kalau angkanya terisi otomatis dari pembacaan alat,
    "manual" kalau diketik petugas. Ini WAJIB tercatat jujur.

    Kalau angka diisi mesin, yang diverifikasi petugas bukan lagi "saya membaca
    termometer dan menuliskannya", melainkan "saya hadir mengecek pada waktu ini
    dan menyaksikan angka tersebut". Tanda tangannya tetap bermakna, tapi laporan
    harus menyatakan asal angkanya apa adanya — kalau tidak, auditor bisa
    menganggap ada pencatatan yang tidak sesuai kenyataan.
    """
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

    # ── Jangan percaya begitu saja klaim "dari sensor" ───────────────────────
    # Nilai sumber_nilai datang dari browser, dan browser bisa saja mengaku
    # "sensor" padahal angkanya diketik tangan. Untuk catatan akreditasi, klaim
    # yang tidak bisa dibuktikan sama saja dengan tidak ada.
    #
    # Karena itu klaim dicocokkan dengan pembacaan yang benar-benar ada di buffer.
    # Kalau tidak cocok, klaimnya diturunkan jadi "manual" — bukan ditolak,
    # karena angkanya sendiri mungkin benar; yang salah cuma pengakuannya.
    sumber_nilai = sumber_nilai if sumber_nilai in ("sensor", "manual") else "manual"
    if sumber_nilai == "sensor":
        cocok = False
        try:
            from services.buffer import get_latest
            rec = get_latest(device_id)
            if rec:
                cocok = (abs(float(rec["temperature"]) - temperature) <= 0.6 and
                         abs(float(rec["humidity"]) - humidity) <= 2.0)
                if cocok and sensor_waktu is None:
                    sensor_waktu = rec.get("timestamp")
        except Exception as exc:
            logger.warning("Gagal memeriksa klaim sumber sensor: %s", exc)
        if not cocok:
            logger.info("Klaim 'sensor' tidak cocok dengan pembacaan %s — dicatat sebagai manual.", device_id)
            sumber_nilai = "manual"
            sensor_waktu = None

    # ── Cegah shift ganda ────────────────────────────────────────────────────
    # Permenkes mensyaratkan TEPAT 3 pencatatan per hari (Pagi/Siang/Malam).
    # Dua entri untuk shift yang sama membuat auditor tidak bisa menentukan mana
    # catatan yang sah — apalagi kalau angkanya berbeda. Kalau petugas ingin
    # membetulkan entri yang sudah ada, jalurnya adalah RALAT (yang menyimpan
    # jejak nilai lama), bukan menambah entri baru yang menimpa maknanya.
    existing = find_existing_shift(db, device_id, shift)
    if existing:
        raise DuplicateShiftError(
            f"Shift {shift} untuk {ROOM_CONFIG[device_id]['name']} hari ini sudah diisi "
            f"({existing.get('temperature')}°C / {existing.get('humidity')}% "
            f"oleh {existing.get('verifikator_name', '-')}). "
            f"Kalau nilainya keliru, gunakan tombol Ralat pada entri tersebut.",
            existing_id=existing["id"],
        )

    # ── Peringatan nilai tidak masuk akal ────────────────────────────────────
    # Ditolak pada percobaan pertama supaya salah ketik tertangkap, tapi bisa
    # dilanjutkan kalau petugas menegaskan angkanya memang benar (allow_extreme).
    if not allow_extreme:
        warn = check_sanity(temperature, humidity)
        if warn:
            raise ImplausibleValueError(warn)

    room = ROOM_CONFIG[device_id]
    ranges = evaluate_ranges(room, temperature, humidity)

    now = datetime.now(timezone.utc)
    doc = {
        "device_id":        device_id,
        "room_name":        room["name"],
        "shift":            shift,
        "verifikator_id":   verifikator_id,
        "verifikator_name": verifikator["name"],
        "temperature":      temperature,
        "humidity":         humidity,
        # Status dinilai terpisah — lihat evaluate_ranges() untuk alasannya.
        "temp_in_range":    ranges["temp_in_range"],
        "hum_in_range":     ranges["hum_in_range"],
        "in_range":         ranges["in_range"],
        "signature":        signature,   # base64 PNG data URL dari signature pad frontend
        "catatan":          (catatan or "").strip(),
        "tindakan":         (tindakan or "").strip(),
        "submitted_at":     now,
        # Akun yang dipakai saat submit (dari token Firebase yang diverifikasi).
        # Berbeda dari verifikator_name: sistem ini memakai 1 akun bersama, jadi
        # 'siapa yang mengetik' dan 'siapa yang bertanggung jawab klinis' dicatat
        # terpisah. Penting untuk telusur audit kalau ada entri dipertanyakan.
        "submitted_by":     (submitted_by or "").strip(),
        # Asal angka: "sensor" (terisi otomatis) atau "manual" (diketik petugas).
        # Dicatat supaya laporan akreditasi jujur menyatakan dari mana nilainya.
        "sumber_nilai":     sumber_nilai,
        # Waktu pembacaan sensor yang dipakai — membuktikan angkanya tidak diambil
        # dari jam lain. Kosong kalau diisi manual.
        "sensor_waktu":     sensor_waktu,
        # Penanda koreksi — diisi kalau entri ini kemudian diralat.
        "corrected":        False,
    }

    _, doc_ref = db.collection("verifications").add(doc)
    out = dict(doc)
    out["id"] = doc_ref.id
    out["submitted_at"] = now.isoformat()
    if hasattr(out.get("sensor_waktu"), "isoformat"):
        out["sensor_waktu"] = out["sensor_waktu"].isoformat()
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

    room = ROOM_CONFIG[device_id]
    results = []
    for d in query.stream():
        v = d.to_dict()
        ts = v.get("submitted_at")
        v["submitted_at"] = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        for key in ("corrected_at", "sensor_waktu"):
            val = v.get(key)
            if val is not None:
                v[key] = val.isoformat() if hasattr(val, "isoformat") else str(val)

        # Entri yang ditulis sebelum fitur isi-otomatis ada tidak punya field ini.
        # Anggap manual — memang begitu kenyataannya saat itu.
        if v.get("sumber_nilai") is None:
            v["sumber_nilai"] = "manual"

        # Entri yang ditulis SEBELUM pemisahan status ini hanya punya `in_range`
        # gabungan. Hitung ulang temp/hum secara terpisah saat dibaca, supaya
        # tampilan mewarnai kolom dengan benar tanpa perlu migrasi data Firestore.
        if v.get("temp_in_range") is None or v.get("hum_in_range") is None:
            t, h = v.get("temperature"), v.get("humidity")
            if isinstance(t, (int, float)) and isinstance(h, (int, float)):
                v.update(evaluate_ranges(room, float(t), float(h)))

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
    ranges = evaluate_ranges(room, temperature, humidity)

    updates = {
        # Simpan nilai asli — inilah yang membuat koreksi bisa diaudit.
        "original_temperature": existing.get("temperature"),
        "original_humidity":    existing.get("humidity"),
        "original_in_range":    existing.get("in_range"),
        "temperature":          temperature,
        "humidity":             humidity,
        "temp_in_range":        ranges["temp_in_range"],
        "hum_in_range":         ranges["hum_in_range"],
        "in_range":             ranges["in_range"],
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
