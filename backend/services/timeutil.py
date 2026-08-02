"""
services/timeutil.py — Konversi waktu WIB ↔ UTC

Semua timestamp DISIMPAN dalam UTC (praktik yang benar: tidak ambigu, tidak
terpengaruh DST, mudah dibandingkan). Tapi semua BATAS yang bermakna bagi
pengguna — "hari ini", "bulan Agustus", "tanggal 5" — harus dihitung dalam
waktu lokal RSND, yaitu WIB (UTC+7).

Kenapa ini penting, bukan sekadar kerapian:

  Tanpa konversi, "awal hari" dihitung sebagai 00:00 UTC = 07:00 WIB. Artinya
  statistik "suhu terendah hari ini" baru mulai dihitung pukul 7 pagi, dan
  shift Malam (22:00 WIB) tercatat sebagai hari BERIKUTNYA dalam UTC.

  Untuk laporan bulanan lebih parah lagi: verifikasi shift Pagi tanggal 1
  Agustus pukul 07:00 WIB = 31 Juli 24:00 UTC, sehingga masuk laporan Juli.
  Di rekap Agustus tanggal 1 terlihat KOSONG padahal perawat sudah mengisi —
  terbaca sebagai shift terlewat saat akreditasi.

WIB tidak punya daylight saving time, jadi offset +7 selalu tetap dan aman
di-hardcode.
"""

from datetime import datetime, timedelta, timezone

WIB = timezone(timedelta(hours=7), name="WIB")


def now_wib() -> datetime:
    """Waktu sekarang dalam WIB."""
    return datetime.now(WIB)


def day_bounds_utc(year: int, month: int, day: int):
    """Awal & akhir satu hari kalender WIB, dikembalikan dalam UTC."""
    start_wib = datetime(year, month, day, tzinfo=WIB)
    end_wib = start_wib + timedelta(days=1)
    return start_wib.astimezone(timezone.utc), end_wib.astimezone(timezone.utc)


def today_start_utc() -> datetime:
    """
    Awal hari ini menurut WIB (00:00 WIB), dalam UTC.
    Dipakai statistik harian supaya "hari ini" berganti tengah malam waktu
    setempat, bukan pukul 07:00 pagi.
    """
    n = now_wib()
    return datetime(n.year, n.month, n.day, tzinfo=WIB).astimezone(timezone.utc)


def parse_date_wib(date_str: str):
    """
    Ubah 'YYYY-MM-DD' menjadi (awal_hari_utc, awal_hari_berikutnya_utc),
    dengan tanggal ditafsirkan sebagai tanggal WIB.
    Melempar ValueError kalau format salah.
    """
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return day_bounds_utc(dt.year, dt.month, dt.day)


# ── Jendela pencatatan shift ────────────────────────────────────────────────
# Jam pencatatan resmi menurut Permenkes 72/2016.
JAM_SHIFT = (7, 14, 22)

# Lampu latar LCD dinyalakan sejak beberapa menit SEBELUM jam shift sampai
# beberapa lama SESUDAHNYA. Rentangnya tidak simetris dengan sengaja: petugas
# lebih sering terlambat daripada datang lebih awal, jadi sisi sesudah dibuat
# lebih panjang.
MENIT_SEBELUM_SHIFT = 15
MENIT_SESUDAH_SHIFT = 45


def dalam_jendela_shift(saat=None) -> bool:
    """
    True kalau sekarang sedang dalam jendela pencatatan shift (waktu WIB).

    Dihitung di SERVER, bukan di ESP32. ESP32 tidak punya jam yang bertahan
    setelah mati, dan menambahkan sinkronisasi NTP berarti menyalakan radio WiFi
    lebih lama — justru menambah pemakaian baterai yang mau dihemat. Server sudah
    tahu waktunya dan sudah membalas setiap kiriman telemetri, jadi status ini
    cukup dititipkan di balasan itu.
    """
    n = (saat or now_wib()).astimezone(WIB)
    menit_sekarang = n.hour * 60 + n.minute
    for jam in JAM_SHIFT:
        pusat = jam * 60
        selisih = menit_sekarang - pusat
        # Normalkan ke rentang -720..720 supaya jendela shift Malam (22.00) tetap
        # terdeteksi benar saat sudah lewat tengah malam.
        if selisih > 720:
            selisih -= 1440
        elif selisih < -720:
            selisih += 1440
        if -MENIT_SEBELUM_SHIFT <= selisih <= MENIT_SESUDAH_SHIFT:
            return True
    return False


def month_bounds_utc(year: int, month: int):
    """Awal & akhir satu bulan kalender WIB, dikembalikan dalam UTC."""
    start_wib = datetime(year, month, 1, tzinfo=WIB)
    if month == 12:
        end_wib = datetime(year + 1, 1, 1, tzinfo=WIB)
    else:
        end_wib = datetime(year, month + 1, 1, tzinfo=WIB)
    return start_wib.astimezone(timezone.utc), end_wib.astimezone(timezone.utc)
