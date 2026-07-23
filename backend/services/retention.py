"""
services/retention.py — Pembersihan otomatis data telemetry lama.

Hanya menyasar collection 'telemetry' (data mentah sensor, volume besar).
Collection 'verifications' (hasil verifikasi shift + tanda tangan digital)
SENGAJA TIDAK disentuh di sini — itu dokumen resmi untuk akreditasi, retensinya
lebih panjang dan diatur terpisah (lihat dokumen spesifikasi bagian 2.5).
"""

import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

TELEMETRY_RETENTION_DAYS = 60   # buffer aman di atas kebutuhan minimum 1 bulan untuk akreditasi
BATCH_SIZE = 500                # batas ukuran batch delete Firestore
MAX_BATCHES_PER_RUN = 40        # guard supaya 1 kali jalan tidak "lari" tanpa henti


def cleanup_old_telemetry(db) -> int:
    """Hapus dokumen telemetry lebih tua dari TELEMETRY_RETENTION_DAYS hari. Return jumlah yang dihapus."""
    if db is None:
        return 0

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

    if deleted_total:
        logger.info("Retention cleanup: %d dokumen telemetry (>%d hari) dihapus.", deleted_total, TELEMETRY_RETENTION_DAYS)
    return deleted_total


def start_scheduler(db):
    """
    Jadwalkan cleanup harian jam 03:00 WIB (20:00 UTC). Dipanggil sekali saat
    startup app.py. Aman dijalankan dalam proses gunicorn 1 worker yang sama
    (lihat catatan buffer.py soal single-worker).
    """
    if db is None:
        logger.warning("DB belum siap — retensi otomatis tidak dijadwalkan.")
        return None
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        logger.warning(
            "APScheduler tidak terpasang — retensi otomatis TIDAK aktif. "
            "Tambahkan 'apscheduler' ke requirements.txt lalu redeploy."
        )
        return None

    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(lambda: cleanup_old_telemetry(db), "cron", hour=20, minute=0, id="telemetry_retention")
    scheduler.start()
    logger.info("Scheduler retensi telemetry aktif (harian, 03:00 WIB, retensi %d hari).", TELEMETRY_RETENTION_DAYS)
    return scheduler
