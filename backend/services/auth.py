"""
services/auth.py — Penjaga akses endpoint backend

MASALAH YANG DIPECAHKAN
Sebelumnya SEMUA endpoint terbuka tanpa autentikasi. Login Firebase di frontend
hanya menyembunyikan tampilan; API-nya sendiri bisa dipanggil siapa saja yang
tahu URL Render. Artinya orang luar bisa:
  - mengubah threshold ruangan (alarm jadi tidak pernah bunyi)
  - menghapus daftar verifikator
  - menyuntik data suhu palsu
  - MEMBUAT ENTRI VERIFIKASI FIKTIF — ini yang paling berbahaya, karena catatan
    kepatuhan dipakai sebagai bukti akreditasi rumah sakit.

DUA JENIS PENJAGA
1. @require_device_key — untuk POST /api/telemetry (dipanggil ESP32).
   ESP32 tidak bisa login Firebase, jadi memakai API key statis lewat header
   X-Device-Key. Sederhana, cukup untuk perangkat di jaringan internal RS.

2. @require_user — untuk endpoint admin & verifikasi (dipanggil browser).
   Memverifikasi Firebase ID token yang dikirim frontend di header
   Authorization: Bearer <token>. Token diverifikasi kriptografis oleh Firebase
   Admin SDK, jadi tidak bisa dipalsukan.

MODE TRANSISI (PENTING)
Kalau variabel lingkungannya belum diset di Render, penjaga TIDAK memblokir —
hanya mencatat peringatan. Ini disengaja supaya deploy perubahan ini tidak
langsung mematikan 6 ESP32 yang sudah terpasang di lapangan sebelum sempat
di-reflash. Setelah semua perangkat dan browser diperbarui, set
AUTH_ENFORCE=true di Render untuk mengunci sepenuhnya.
"""

import logging
import os
import time
from functools import wraps

from flask import request, jsonify

logger = logging.getLogger(__name__)

# key -> waktu terakhir diperingatkan. Dulu ini set, artinya tiap jenis masalah
# hanya dicatat SEKALI seumur hidup proses. Untuk peringatan device key itu
# berbahaya: alat pertama yang salah kunci memicu peringatan, lalu lima alat
# lain yang juga salah lewat tanpa jejak. Log yang sunyi jadi tampak seperti
# "semua sudah benar" padahal belum — persis kesimpulan keliru yang membuat
# orang menyalakan AUTH_ENFORCE terlalu cepat.
_warned: dict = {}
_WARN_INTERVAL_S = 1800   # ulangi peringatan tiap 30 menit selama masalah belum beres

# Status kunci per alat, dipakai halaman Setting supaya tidak perlu menelusuri
# log Render satu per satu sebelum menyalakan AUTH_ENFORCE.
_status_kunci: dict = {}   # device_id -> {"ok": bool, "terakhir": epoch}


def _enforcing() -> bool:
    """True kalau penolakan benar-benar diberlakukan (bukan sekadar peringatan)."""
    return os.environ.get("AUTH_ENFORCE", "").strip().lower() in ("1", "true", "yes")


def _warn_berkala(key: str, message: str) -> None:
    """Catat peringatan, lalu diam sebentar supaya log tidak banjir — tapi TIDAK
    diam selamanya, karena masalah yang masih berlangsung harus tetap terlihat."""
    sekarang = time.time()
    if sekarang - _warned.get(key, 0) >= _WARN_INTERVAL_S:
        _warned[key] = sekarang
        logger.warning(message)


def _fail(reason: str, key: str, hint: str):
    """
    Kembalikan response 401 kalau sedang enforce; kalau belum, cuma catat log
    dan biarkan lewat (mode transisi).
    """
    if _enforcing():
        return jsonify({"error": reason}), 401
    _warn_berkala(key, f"[AUTH] {reason} — DILEWATKAN karena AUTH_ENFORCE belum aktif. {hint}")
    return None


def _device_id_dari_request() -> str:
    """
    Ambil device_id dari badan permintaan untuk keperluan log.

    Nilai ini TIDAK dipakai untuk mengambil keputusan keamanan — hanya untuk
    memberi tahu unit mana yang perlu di-flash ulang. Kalau isinya ngawur,
    paling buruk hanya membuat pesan log ikut ngawur.
    """
    try:
        data = request.get_json(silent=True) or {}
        nilai = str(data.get("device_id") or "").strip()
        return nilai[:40] if nilai else "TANPA-ID"
    except Exception:
        return "TANPA-ID"


def _catat_status_kunci(device_id: str, ok: bool) -> None:
    """
    Catat hasil pemeriksaan kunci dan umumkan sekali per alat.

    Kunci yang benar SELALU dicatat saat pertama kali alat terlihat, bukan hanya
    saat berpindah dari salah ke benar. Versi sebelumnya hanya mencatat
    perpindahan, akibatnya alat yang sudah benar sejak server menyala tidak
    pernah menghasilkan baris apa pun — dan tidak adanya baris itu mustahil
    dibedakan dari "backend belum ter-deploy". Konfirmasi yang hanya muncul
    kadang-kadang tidak berguna sebagai penanda kesiapan.
    """
    sebelumnya = _status_kunci.get(device_id)
    _status_kunci[device_id] = {"ok": ok, "terakhir": time.time()}
    if not ok:
        return                                  # sisi gagal sudah dicatat oleh _fail()
    if sebelumnya is None:
        logger.info("[AUTH] %s: kunci BENAR.", device_id)
    elif not sebelumnya.get("ok"):
        logger.info("[AUTH] %s sekarang mengirim kunci yang BENAR.", device_id)


def status_kunci_perangkat() -> dict:
    """Ringkasan status kunci tiap alat, untuk ditampilkan di halaman Setting."""
    return {
        dev: {"ok": bool(v["ok"]), "terakhir": v["terakhir"]}
        for dev, v in _status_kunci.items()
    }


def require_device_key(fn):
    """Lindungi endpoint yang dipanggil ESP32 dengan API key statis."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        expected = os.environ.get("DEVICE_API_KEY", "").strip()
        if not expected:
            failed = _fail(
                "DEVICE_API_KEY belum diset di server",
                "device_key_unset",
                "Set DEVICE_API_KEY di Render, lalu isi nilai yang sama di firmware ESP32.",
            )
            if failed:
                return failed
            return fn(*args, **kwargs)

        provided = request.headers.get("X-Device-Key", "")
        device_id = _device_id_dari_request()

        if provided != expected:
            _catat_status_kunci(device_id, False)
            sebab = ("belum mengirim header X-Device-Key sama sekali"
                     if not provided else "mengirim X-Device-Key yang tidak cocok")
            failed = _fail(
                f"Device key tidak valid dari {device_id}",
                # Kunci dedup dibuat per alat: kalau dijadikan satu, unit pertama
                # yang bermasalah akan menutupi unit-unit lain yang juga bermasalah.
                f"device_key_bad:{device_id}",
                f"Unit {device_id} {sebab}. Flash ulang unit ini dengan "
                f"DEVICE_API_KEY yang sama seperti di Render.",
            )
            if failed:
                return failed
        else:
            _catat_status_kunci(device_id, True)
        return fn(*args, **kwargs)
    return wrapper


def verify_user_token():
    """
    Verifikasi Firebase ID token dari header Authorization.
    Return dict info user kalau valid, None kalau tidak ada/tidak valid.
    """
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    try:
        from firebase_admin import auth as fb_auth
        decoded = fb_auth.verify_id_token(token)
        return {
            "uid":   decoded.get("uid"),
            "email": decoded.get("email") or decoded.get("uid"),
        }
    except Exception as exc:
        logger.info("[AUTH] Token ditolak: %s", exc)
        return None


def require_user(fn):
    """
    Lindungi endpoint yang hanya boleh dipanggil staf yang sudah login.

    Kalau token valid, identitas asli user diselipkan ke request sebagai
    request.auth_user. Endpoint admin memakainya sebagai 'changed_by' di audit
    log — jauh lebih tepercaya daripada nilai yang dikirim frontend, karena
    nilai dari frontend bisa dipalsukan siapa saja.
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = verify_user_token()
        if user is None:
            failed = _fail(
                "Perlu login. Sertakan header Authorization: Bearer <Firebase ID token>",
                "user_token_missing",
                "Frontend belum mengirim token, atau tokennya kedaluwarsa.",
            )
            if failed:
                return failed
        request.auth_user = user
        return fn(*args, **kwargs)
    return wrapper


def actor_email(fallback: str = "unknown") -> str:
    """
    Siapa yang melakukan aksi ini, untuk audit log.
    Utamakan identitas dari token (tidak bisa dipalsukan); baru jatuh ke nilai
    kiriman frontend kalau autentikasi belum diberlakukan.
    """
    user = getattr(request, "auth_user", None)
    if user and user.get("email"):
        return user["email"]
    return fallback or "unknown"
