# ClimateOS — Weather & Room Climate Monitoring Dashboard

A production-grade IoT dashboard built on Firebase, ESP32 (Python mock), Gemini AI, and OpenWeatherMap.

---

## Project Structure

```
weather-dashboard/
├── firebase.json                     # Firebase Hosting + Functions config
├── public/                           # Frontend (Firebase Hosting)
│   ├── index.html                    # Full Bento Grid dashboard UI
│   └── app.js                        # Modular ES6+ JS (gauges, chart, chat, STT, export)
└── functions/                        # Python Cloud Functions (2nd Gen)
    ├── main.py                       # All HTTP function entry points
    ├── requirements.txt              # Python dependencies
    ├── services/
    │   ├── __init__.py
    │   ├── notifier.py               # Discord alerting state machine
    │   └── weather.py                # OpenWeatherMap + Firestore cache
    └── routes/
        ├── __init__.py
        └── ai.py                     # Gemini AI chat with live context injection
```

---

## Prerequisites

- Firebase project with Blaze (pay-as-you-go) plan
- Google Cloud Secret Manager enabled
- Firestore in Native mode
- Node.js 18+ (for Firebase CLI)
- Python 3.11+

---

## Environment Secrets (Google Cloud Secret Manager)

Store these three secrets before deploying:

```bash
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
echo -n "YOUR_DISCORD_WEBHOOK_URL" | gcloud secrets create DISCORD_WEBHOOK_URL --data-file=-
echo -n "YOUR_OPENWEATHER_API_KEY" | gcloud secrets create OPENWEATHER_API_KEY --data-file=-
```

Grant your Cloud Functions service account access:
```bash
PROJECT_ID=$(gcloud config get-value project)
SA="$PROJECT_ID@appspot.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Firestore Index (Required)

Deploy this composite index for the telemetry queries to work:

```bash
# firestore.indexes.json
{
  "indexes": [
    {
      "collectionGroup": "telemetry",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "telemetry",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "timestamp", "order": "ASCENDING" }
      ]
    }
  ]
}
```

---

## Deploy

```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_PROJECT_ID

# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only hosting
firebase deploy --only hosting
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/telemetry` | Ingest ESP32 sensor data |
| GET | `/api/history?range=live\|1h\|3h\|12h\|24h` | Fetch time-windowed data |
| GET | `/api/stats` | Today's min/max/avg/count |
| GET | `/api/weather` | Outdoor Semarang weather (cached 10 min) |
| POST | `/api/chat` | Gemini AI chat with context injection |

---

## ESP32 Real Hardware Integration

Replace the `MockESP32` simulator in `app.js` with your ESP32 firmware.
Your ESP32 should POST to `https://YOUR-PROJECT.web.app/api/telemetry`:

```cpp
// Arduino ESP32 snippet
#include <HTTPClient.h>
#include <ArduinoJson.h>

void sendTelemetry(float temp, float hum) {
  HTTPClient http;
  http.begin("https://YOUR-PROJECT.web.app/api/telemetry");
  http.addHeader("Content-Type", "application/json");
  
  StaticJsonDocument<128> doc;
  doc["temperature"] = temp;
  doc["humidity"] = hum;
  doc["device_id"] = "esp32-room-01";
  
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  http.end();
}
```

---

## Discord Alert States

The notifier uses a Firestore-persisted state machine:

```
normal ──(temp ≥ 32°C)──► critical  [sends: 🚨 Critical Alert]
critical ──(5+ min elapsed)──► critical_reminded  [sends: 🔁 Reminder]
critical/reminded ──(temp < 32°C)──► normal  [sends: ✅ Resolved]
```

State is stored in `Firestore/_system/alert_state` to survive function cold starts.
