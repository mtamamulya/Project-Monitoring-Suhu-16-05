"""
services/weather.py
Outdoor weather fetcher for Semarang using OpenWeatherMap API.
Results are cached in Firestore to avoid unnecessary API calls.
Cache TTL is 10 minutes.
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
import requests
from firebase_admin import firestore

logger = logging.getLogger(__name__)

CACHE_TTL_MINUTES = 10
SEMARANG_CITY = "Semarang,ID"
OWM_BASE_URL = "https://api.openweathermap.org/data/2.5/weather"


def _get_cache_doc():
    db = firestore.client()
    return db.collection("_system").document("weather_cache")


def _is_cache_valid(cached_at: Optional[str]) -> bool:
    if not cached_at:
        return False
    if isinstance(cached_at, str):
        cached_dt = datetime.fromisoformat(cached_at)
    else:
        cached_dt = cached_at
    # Ensure timezone-aware comparison
    if cached_dt.tzinfo is None:
        cached_dt = cached_dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - cached_dt < timedelta(minutes=CACHE_TTL_MINUTES)


def get_outdoor_weather(api_key: str) -> dict:
    """
    Fetch current outdoor weather for Semarang. Returns cached data if
    still within TTL window; otherwise fetches fresh data from OpenWeatherMap.
    
    Returns a normalized dict:
    {
        "temperature": float,      # °C
        "humidity": float,         # %
        "description": str,
        "icon": str,               # OWM icon code
        "feels_like": float,
        "wind_speed": float,       # m/s
        "cached": bool,
        "fetched_at": str          # ISO 8601 UTC
    }
    """
    cache_doc = _get_cache_doc()
    cached = cache_doc.get()

    if cached.exists:
        data = cached.to_dict()
        if _is_cache_valid(data.get("fetched_at")):
            logger.info("Returning cached outdoor weather data.")
            data["cached"] = True
            return data

    # Cache miss or expired — fetch fresh data
    try:
        params = {
            "q": SEMARANG_CITY,
            "appid": api_key,
            "units": "metric",
        }
        resp = requests.get(OWM_BASE_URL, params=params, timeout=8)
        resp.raise_for_status()
        raw = resp.json()

        now_iso = datetime.now(timezone.utc).isoformat()
        weather_data = {
            "temperature": float(raw["main"]["temp"]),
            "humidity": float(raw["main"]["humidity"]),
            "feels_like": float(raw["main"]["feels_like"]),
            "description": raw["weather"][0]["description"].capitalize(),
            "icon": raw["weather"][0]["icon"],
            "wind_speed": float(raw["wind"]["speed"]),
            "fetched_at": now_iso,
            "cached": False,
        }

        # Persist to Firestore cache
        cache_doc.set(weather_data)
        logger.info("Fetched fresh outdoor weather for Semarang.")
        return weather_data

    except requests.RequestException as exc:
        logger.error("OpenWeatherMap fetch failed: %s", exc)
        # Return last known cached data even if expired, rather than failing hard
        if cached.exists:
            stale = cached.to_dict()
            stale["cached"] = True
            stale["stale"] = True
            return stale
        raise RuntimeError(f"Weather fetch failed and no cached fallback available: {exc}") from exc
