"""
services/retention.py — Pembersihan otomatis data telemetry lama.

Hanya menyasar collection 'telemetry' (data mentah sensor, volume besar).
Collection 'verifications' (hasil verifikasi shift + tanda tangan digital)
SENGAJA TIDAK disentuh di sini — itu dokumen resmi untuk akreditasi, retensinya
lebih panjang dan diatur terpisah (lihat dokumen spesifikasi bagian 2.5).

── KENAPA ADA TIGA PEMICU ────────────────────────────────────────────────────
Render free tier MENIDURKAN container setelah ~15 menit tanpa request. Scheduler
in-process (APScheduler) ikut mati saat itu. Jadwal 03:00 WIB praktis tidak
pernah tercapai karena jam 3 pagi hampir pasti tidak ada yang membuka dashboard —
akibatnya data telemetry menumpuk tanpa batas dan kuota Firestore habis diam-diam.

Karena itu cleanup bisa dipicu tiga cara, saling melengkapi:

  1. Scheduler in-process — bekerja kalau server memang hidup terus
     (Render berbayar, VPS, atau saat dashboard sedang ramai dipakai).
  2. Piggyback pada request masuk (maybe_run_cleanup) — begitu ada aktivitas
     apa pun dan cleanup terakhir sudah lebih dari sehari, jalankan di latar.
     Ini yang paling andal di free tier: tidak butuh apa pun dari luar.
  3. Endpoint /api/admin/run-retention — untuk dipanggil cron eksternal
     (mis. cron-job.org) kalau ingin waktunya pasti.

Ketiganya memakai penanda waktu yang sama (_last_run_at) sehingga tidak akan
menghapus dua kali dalam sehari, berapa pun jumlah pemicu yang aktif.
"""

import logging
import threading
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

TELEMETRY_RETENTION_DAYS = 60   # buffer aman di atas kebutuhan minimum 1 bulan untuk akreditasi
BATCH_SIZE = 500                # batas ukuran batch delete Firestore
MAX_BATCHES_PER_RUN = 40        # guard supaya 1 kali jalan tidak "lari" tanpa henti

MIN_INTERVAL_HOURS = 20         # jeda minimum antar cleanup, dari pemicu mana pun

_last_run_at = None             # datetime UTC terakhir cleanup dijalankan
_run_lock = threading.Lock()    # cegah dua pemicu jalan bersamaan
_running = False


def get_status() -> dict:
    """Ringkasan kondisi retensi — dipakai endpoint admin untuk transparansi."""
    return {
        "retention_days":     TELEMETRY_RETENTION_DAYS,
        "last_run_at":        _last_run_at.isoformat() if _last_run_at else None,
        "currently_running":  _running,
        "min_interval_hours": MIN_INTERVAL_HOURS,
    }


def cleanup_old_telemetry(db) -> int:
    """Hapus dokumen telemetry lebih tua dari TELEMETRY_RETENTION_DAYS hari. Return jumlah yang dihapus."""
    global _last_run_at, _running
    if db is None:
        return 0

    # Kalau sudah ada yang menjalankan, jangan tumpuk — kembalikan saja.
    with _run_lock:
        if _running:
            logger.info("Retention cleanup sedang berjalan — permintaan diabaikan.")
            return 0
        _running = True

    cutoff = datetime.now(timezone.utc) - timedelta(days=TELEMETRY_RETENTION_DAYS)
    deleted_total = 0

    try:
        for _ in range(MAX_BATCHES_PER_RUN):
            docs = list(
                db.collection("telemetry")
                .where("timestamp", "<", cutoff)
                .limit(BATCH_SIZE)
                .stream()
            )
            if not docs:
                break
            batch = db.batch()
            for d in docs:
                batch.delete(d.reference)
            batch.commit()
            deleted_total += len(docs)
            if len(docs) < BATCH_SIZE:
                break
    except Exception as exc:
        logger.error("Retention cleanup gagal: %s", exc)
    finally:
        # Tandai sudah jalan walau nol dokumen terhapus — itu tetap "sudah dicek
        # hari ini", jadi tidak perlu diulang tiap request masuk.
        _last_run_at = datetime.now(timezone.utc)
        with _run_lock:
            _running = False

    if deleted_total:
        logger.info("Retention cleanup: %d dokumen telemetry (>%d hari) dihapus.", deleted_total, TELEMETRY_RETENTION_DAYS)
    else:
        logger.info("Retention cleanup: tidak ada dokumen telemetry lebih tua dari %d hari.", TELEMETRY_RETENTION_DAYS)
    return deleted_total


def maybe_run_cleanup(db) -> bool:
    """
    Pemicu oportunistik: dipanggil dari request yang masuk (lihat app.py).
    Menjalankan cleanup di thread latar HANYA kalau sudah lewat MIN_INTERVAL_HOURS
    sejak terakhir. Sangat murah kalau belum waktunya — cuma satu perbandingan
    datetime, tidak menyentuh Firestore sama sekali.

    Return True kalau cleanup benar-benar dijadwalkan kali ini.
    """
    if db is None or _running:
        return False
    if _last_run_at is not None:
        if datetime.now(timezone.utc) - _last_run_at < timedelta(hours=MIN_INTERVAL_HOURS):
            return False

    # Jalankan di latar supaya request pengguna (atau kiriman ESP32) tidak ikut
    # menunggu proses penghapusan yang bisa memakan puluhan detik.
    t = threading.Thread(target=cleanup_old_telemetry, args=(db,), daemon=True)
    t.start()
    logger.info("Retention cleanup dipicu oleh aktivitas request (piggyback).")
    return True


def start_scheduler(db):
    """
    Jadwalkan cleanup harian jam 03:00 WIB (20:00 UTC). Dipanggil sekali saat
    startup app.py. Aman dijalankan dalam proses gunicorn 1 worker yang sama
    (lihat catatan buffer.py soal single-worker).

    CATATAN PENTING: di Render free tier scheduler ini sering TIDAK PERNAH memicu
    karena container tidur di jam-jam sepi. Itu bukan kegagalan — pemicu piggyback
    (maybe_run_cleanup) dan endpoint cron eksternal yang menjadi jaring pengamannya.
    """
    if db is None:
        logger.warning("DB belum siap — scheduler retensi tidak dijalankan (pemicu piggyback tetap aktif).")
        return None
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        logger.warning(
            "APScheduler tidak terpasang — scheduler retensi TIDAK aktif. "
            "Pemicu piggyback tetap bekerja, jadi data lama masih akan dibersihkan."
        )
        return None

    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(lambda: cleanup_old_telemetry(db), "cron", hour=20, minute=0, id="telemetry_retention")
    scheduler.start()
    logger.info("Scheduler retensi telemetry aktif (harian, 03:00 WIB, retensi %d hari).", TELEMETRY_RETENTION_DAYS)
    return scheduler
