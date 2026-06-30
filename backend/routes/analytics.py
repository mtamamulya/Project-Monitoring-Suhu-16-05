"""
routes/analytics.py — ML Analytics endpoint
Menjalankan Linear Regression, Z-Score Anomaly Detection, K-Means Clustering,
dan kalkulasi SHAP sederhana pada data historis Firestore.
Pola import/penggunaan sama dengan routes/ai.py.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

from services.notifier import ROOM_CONFIG

logger = logging.getLogger(__name__)

WIB = timezone(timedelta(hours=7))

# ── Heat Index formula (Rothfusz, Celsius) ────────────────────
def _heat_index_c(t: float, h: float) -> float:
    """Hitung Heat Index dalam Celsius menggunakan formula Rothfusz."""
    tf = t * 9 / 5 + 32  # ke Fahrenheit
    hi_f = (-42.379 + 2.04901523 * tf + 10.14333127 * h
            - 0.22475541 * tf * h - 0.00683783 * tf * tf
            - 0.05391553 * h * h + 0.00122874 * tf * tf * h
            + 0.00085282 * tf * h * h - 0.00000199 * tf * tf * h * h)
    return (hi_f - 32) * 5 / 9  # balik ke Celsius


# ── Ambil data Firestore ──────────────────────────────────────
def _fetch_firestore_data(db, device_id: str | None, range_days: int) -> list[dict]:
    """
    Query Firestore: ambil max 2000 record paling baru dalam range_days hari.
    Jika device_id=None, ambil semua ruangan terdaftar.
    Pola sama dengan compliance endpoint di app.py.
    """
    now        = datetime.now(timezone.utc)
    start_time = now - timedelta(days=range_days)

    try:
        query = db.collection("telemetry").where("timestamp", ">=", start_time)
        if device_id and device_id in ROOM_CONFIG:
            query = query.where("device_id", "==", device_id)
        query = query.order_by("timestamp", direction="DESCENDING").limit(2000)
        docs  = list(query.stream())
    except Exception as exc:
        logger.error("Analytics Firestore query failed: %s", exc)
        return []

    records = []
    for doc in docs:
        d = doc.to_dict()
        if d.get("temperature") is None or d.get("humidity") is None:
            continue
        if not isinstance(d["temperature"], (int, float)) or not isinstance(d["humidity"], (int, float)):
            continue
        records.append({
            "temperature": float(d["temperature"]),
            "humidity":    float(d["humidity"]),
            "device_id":   d.get("device_id", ""),
            "timestamp":   d.get("timestamp"),
        })
    # Kembalikan urutan ascending untuk time-series
    records.reverse()
    return records


# ── Linear Regression — Forecasting ──────────────────────────
def _run_linear_regression(values: list[float], forecast_steps: int = 10) -> dict:
    """
    Fit Linear Regression pada series nilai, prediksi `forecast_steps` titik ke depan.
    Return: coef, intercept, r2, prediksi_masa_depan, fitted_values
    """
    n = len(values)
    if n < 5:
        return {"error": "Data tidak cukup"}

    X = np.arange(n).reshape(-1, 1)
    y = np.array(values)

    model = LinearRegression()
    model.fit(X, y)

    fitted     = model.predict(X).tolist()
    future_X   = np.arange(n, n + forecast_steps).reshape(-1, 1)
    future_y   = model.predict(future_X).tolist()
    r2         = float(model.score(X, y))

    return {
        "coef":        float(model.coef_[0]),
        "intercept":   float(model.intercept_),
        "r2":          round(r2, 4),
        "fitted":      [round(v, 2) for v in fitted],
        "forecast":    [round(v, 2) for v in future_y],
    }


# ── Z-Score Anomaly Detection ─────────────────────────────────
def _detect_anomalies(temps: list[float], threshold: float = 2.5) -> dict:
    """
    Deteksi anomali suhu menggunakan Z-Score.
    Titik dengan |Z| > threshold dianggap anomali.
    """
    if len(temps) < 5:
        return {"error": "Data tidak cukup", "anomaly_indices": [], "count": 0}

    arr    = np.array(temps)
    mean   = float(arr.mean())
    std    = float(arr.std())

    if std == 0:
        return {"mean": mean, "std": 0.0, "anomaly_indices": [], "count": 0, "threshold": threshold}

    z_scores        = ((arr - mean) / std).tolist()
    anomaly_indices = [i for i, z in enumerate(z_scores) if abs(z) > threshold]

    return {
        "mean":             round(mean, 2),
        "std":              round(std, 2),
        "z_scores":         [round(z, 3) for z in z_scores],
        "anomaly_indices":  anomaly_indices,
        "count":            len(anomaly_indices),
        "threshold":        threshold,
    }


# ── K-Means Clustering ────────────────────────────────────────
def _run_kmeans(temps: list[float], hums: list[float], k: int = 3) -> dict:
    """
    K-Means 3 cluster pada (suhu, kelembaban).
    Cluster diberi label otomatis berdasarkan rata-rata suhu:
      terendah = Profil Dingin, tengah = Profil Optimal, tertinggi = Profil Panas
    """
    if len(temps) < k * 3:
        return {"error": "Data tidak cukup untuk K-Means"}

    X       = np.column_stack([temps, hums])
    scaler  = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    km      = KMeans(n_clusters=k, random_state=42, n_init=10)
    labels  = km.fit_predict(X_scaled).tolist()

    # Hitung rata-rata suhu per cluster untuk labeling
    cluster_temp_means = {}
    for i in range(k):
        idxs = [j for j, l in enumerate(labels) if l == i]
        cluster_temp_means[i] = np.mean([temps[j] for j in idxs]) if idxs else 0

    # Urutkan cluster dari dingin ke panas
    sorted_clusters = sorted(cluster_temp_means, key=lambda c: cluster_temp_means[c])
    profile_labels  = {sorted_clusters[0]: "Profil Dingin",
                       sorted_clusters[1]: "Profil Optimal",
                       sorted_clusters[2]: "Profil Panas"}
    profile_colors  = {sorted_clusters[0]: "blue",
                       sorted_clusters[1]: "green",
                       sorted_clusters[2]: "red"}

    # Hitung stats per cluster
    cluster_stats = {}
    for i in range(k):
        idxs = [j for j, l in enumerate(labels) if l == i]
        if idxs:
            cluster_stats[profile_labels[i]] = {
                "count":    len(idxs),
                "temp_avg": round(float(np.mean([temps[j] for j in idxs])), 2),
                "hum_avg":  round(float(np.mean([hums[j]  for j in idxs])), 2),
                "color":    profile_colors[i],
            }

    # Dominant cluster
    dominant = max(cluster_stats, key=lambda k: cluster_stats[k]["count"])

    return {
        "labels":        [profile_labels[l] for l in labels],
        "cluster_stats": cluster_stats,
        "dominant":      dominant,
        "k":             k,
    }


# ── SHAP sederhana — kontribusi suhu & kelembaban ke Heat Index ─
def _compute_shap(temps: list[float], hums: list[float], room_cfg: dict) -> dict:
    """
    Hitung kontribusi suhu dan kelembaban terhadap Heat Index
    dibandingkan baseline (midpoint threshold ruangan).
    Menggunakan partial derivative dari formula Rothfusz.
    """
    if not temps:
        return {}

    avg_temp   = float(np.mean(temps))
    avg_hum    = float(np.mean(hums))
    baseline_t = (room_cfg["tempMin"] + room_cfg["tempMax"]) / 2
    baseline_h = (room_cfg["humMin"]  + room_cfg["humMax"])  / 2

    hi_actual   = _heat_index_c(avg_temp, avg_hum)
    hi_baseline = _heat_index_c(baseline_t, baseline_h)
    hi_temp_ref = _heat_index_c(avg_temp, baseline_h)   # hanya suhu berubah
    hi_hum_ref  = _heat_index_c(baseline_t, avg_hum)    # hanya kelembaban berubah

    temp_impact = round(hi_temp_ref - hi_baseline, 2)
    hum_impact  = round(hi_hum_ref  - hi_baseline, 2)

    return {
        "avg_temp":      round(avg_temp, 2),
        "avg_hum":       round(avg_hum,  2),
        "baseline_temp": baseline_t,
        "baseline_hum":  baseline_h,
        "heat_index":    round(hi_actual, 2),
        "hi_baseline":   round(hi_baseline, 2),
        "temp_impact":   temp_impact,
        "hum_impact":    hum_impact,
        "temp_label":    "penyumbang hawa panas" if temp_impact > 0 else "penyumbang rasa sejuk",
        "hum_label":     "penyumbang rasa pengap" if hum_impact > 0 else "penyumbang kenyamanan",
    }


# ── Entry point dipanggil dari app.py ────────────────────────
def run_analytics(db, device_id: str | None, range_days: int) -> dict[str, Any]:
    """
    Jalankan semua analisis ML pada data historis.
    Dipanggil dari endpoint /api/analytics di app.py.
    """
    records = _fetch_firestore_data(db, device_id, range_days)

    if len(records) < 10:
        return {
            "error":        "Data tidak cukup untuk analisis",
            "record_count": len(records),
            "min_required": 10,
        }

    temps = [r["temperature"] for r in records]
    hums  = [r["humidity"]    for r in records]

    # Timestamp untuk sumbu x chart
    timestamps = []
    for r in records:
        ts = r.get("timestamp")
        if ts and hasattr(ts, "astimezone"):
            timestamps.append(ts.astimezone(WIB).isoformat())
        elif ts:
            timestamps.append(str(ts))
        else:
            timestamps.append(None)

    # Ambil konfigurasi ruangan
    room_cfg = ROOM_CONFIG.get(device_id, {}) if device_id else {}
    if not room_cfg and ROOM_CONFIG:
        room_cfg = next(iter(ROOM_CONFIG.values()))

    # Jalankan semua analisis
    temp_forecast = _run_linear_regression(temps, forecast_steps=12)
    hum_forecast  = _run_linear_regression(hums,  forecast_steps=12)
    anomaly       = _detect_anomalies(temps, threshold=2.5)
    kmeans        = _run_kmeans(temps, hums, k=3)
    shap          = _compute_shap(temps, hums, room_cfg)

    return {
        "record_count":    len(records),
        "device_id":       device_id,
        "range_days":      range_days,
        "timestamps":      timestamps,
        "temps":           temps,
        "hums":            hums,
        "temp_avg":        round(float(np.mean(temps)), 2),
        "temp_min":        round(float(np.min(temps)),  2),
        "temp_max":        round(float(np.max(temps)),  2),
        "hum_avg":         round(float(np.mean(hums)),  2),
        "temp_forecast":   temp_forecast,
        "hum_forecast":    hum_forecast,
        "anomaly":         anomaly,
        "kmeans":          kmeans,
        "shap":            shap,
        "room_name":       room_cfg.get("name", "Semua Ruangan") if device_id else "Semua Ruangan",
        "generated_at":    datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S WIB"),
    }
