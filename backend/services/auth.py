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
from functools import wraps

from flask import request, jsonify

logger = logging.getLogger(__name__)

_warned = set()


def _enforcing() -> bool:
    """True kalau penolakan benar-benar diberlakukan (bukan sekadar peringatan)."""
    return os.environ.get("AUTH_ENFORCE", "").strip().lower() in ("1", "true", "yes")


def _warn_once(key: str, message: str) -> None:
    if key not in _warned:
        _warned.add(key)
        logger.warning(message)


def _fail(reason: str, key: str, hint: str):
    """
    Kembalikan response 401 kalau sedang enforce; kalau belum, cuma catat log
    dan biarkan lewat (mode transisi).
    """
    if _enforcing():
        return jsonify({"error": reason}), 401
    _warn_once(key, f"[AUTH] {reason} — DILEWATKAN karena AUTH_ENFORCE belum aktif. {hint}")
    return None


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
        if provided != expected:
            failed = _fail(
                "Device key tidak valid",
                "device_key_bad",
                "ESP32 mengirim X-Device-Key yang salah atau belum mengirimnya sama sekali.",
            )
            if failed:
                return failed
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
