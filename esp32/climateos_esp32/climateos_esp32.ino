/**
 * ============================================================
 *  ClimateOS — ESP32 Firmware
 *  Hardware : ESP32 DevKit + DHT22 Sensor
 *  Tujuan   : Baca suhu & kelembaban, kirim ke Firebase
 *             endpoint /api/telemetry setiap interval tertentu.
 * ============================================================
 *
 *  Wiring DHT22:
 *  ┌─────────┬───────────────┐
 *  │ DHT22   │ ESP32         │
 *  ├─────────┼───────────────┤
 *  │ VCC (+) │ 3.3V          │
 *  │ DATA    │ GPIO 4        │
 *  │ GND (-) │ GND           │
 *  └─────────┴───────────────┘
 *  Pasang resistor pull-up 10kΩ antara VCC dan DATA pin.
 *
 *  Library yang dibutuhkan (install via Arduino Library Manager):
 *  - DHT sensor library by Adafruit
 *  - Adafruit Unified Sensor by Adafruit
 *  - ArduinoJson by Benoit Blanchon
 *  - WiFiClientSecure (built-in ESP32 core)
 *  - HTTPClient (built-in ESP32 core)
 * ============================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ── KONFIGURASI — UBAH BAGIAN INI ────────────────────────────
#define WIFI_SSID        "om bob meresahkan"
#define WIFI_PASSWORD    "ayamgeprek"

// URL endpoint backend Render kamu
#define API_ENDPOINT     "https://climateos-backend.onrender.com/api/telemetry"

// ID unik untuk perangkat ini (bebas diisi apa saja)
#define DEVICE_ID        "esp32-kamar-01"

// Pin dan tipe sensor
#define DHT_PIN          4
#define DHT_TYPE         DHT11   // Ganti ke DHT11 jika pakai DHT11

// Interval pengiriman data (dalam milidetik)
// Default: 15 detik — sesuai polling interval dashboard
#define SEND_INTERVAL_MS 15000

// Batas retry koneksi WiFi
#define WIFI_MAX_RETRY   20
// ─────────────────────────────────────────────────────────────

// ── Inisialisasi Sensor ───────────────────────────────────────
DHT dht(DHT_PIN, DHT_TYPE);

// ── Status LED bawaan ESP32 (GPIO 2) ─────────────────────────
#define LED_PIN 2

// ── Variabel global ───────────────────────────────────────────
unsigned long lastSendTime = 0;
int failCount = 0;

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Koneksi WiFi
// ─────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.println("\n[WiFi] Menghubungkan ke: " + String(WIFI_SSID));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < WIFI_MAX_RETRY) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] ✓ Terhubung!");
    Serial.println("[WiFi] IP Address: " + WiFi.localIP().toString());
    digitalWrite(LED_PIN, HIGH);  // LED nyala = WiFi OK
  } else {
    Serial.println("\n[WiFi] ✗ Gagal terhubung. Restart dalam 5 detik...");
    delay(5000);
    ESP.restart();
  }
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Baca Sensor DHT22
//  Mengembalikan false jika pembacaan gagal (NaN)
// ─────────────────────────────────────────────────────────────
bool readSensor(float &temperature, float &humidity) {
  // DHT22 butuh ~2 detik antar pembacaan
  humidity    = dht.readHumidity();
  temperature = dht.readTemperature();  // Celsius

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("[Sensor] ✗ Gagal membaca DHT22. Cek wiring!");
    return false;
  }

  // Validasi range yang masuk akal
  if (temperature < -40 || temperature > 80) {
    Serial.println("[Sensor] ✗ Nilai suhu di luar range: " + String(temperature));
    return false;
  }
  if (humidity < 0 || humidity > 100) {
    Serial.println("[Sensor] ✗ Nilai kelembaban di luar range: " + String(humidity));
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
//  FUNGSI: Kirim Data ke Firebase API
// ─────────────────────────────────────────────────────────────
bool sendTelemetry(float temperature, float humidity) {
  // Reconnect WiFi jika terputus
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Koneksi terputus, reconnecting...");
    connectWiFi();
  }

  // Buat JSON payload
  StaticJsonDocument<128> doc;
  doc["temperature"] = round(temperature * 100.0) / 100.0;  // 2 desimal
  doc["humidity"]    = round(humidity * 100.0) / 100.0;
  doc["device_id"]   = DEVICE_ID;

  String payload;
  serializeJson(doc, payload);

  Serial.println("[HTTP] Mengirim: " + payload);

  // HTTPS client (Firebase butuh SSL)
  WiFiClientSecure client;
  client.setInsecure();  // Skip SSL cert verification
                         // Untuk produksi pakai: client.setCACert(root_ca);

  HTTPClient http;
  http.begin(client, API_ENDPOINT);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);  // 10 detik timeout

  int httpCode = http.POST(payload);
  String response = http.getString();
  http.end();

  if (httpCode == 201) {
    Serial.println("[HTTP] ✓ Berhasil! Code: " + String(httpCode));
    Serial.println("[HTTP] Response: " + response);
    failCount = 0;
    return true;
  } else {
    Serial.println("[HTTP] ✗ Gagal! Code: " + String(httpCode));
    Serial.println("[HTTP] Response: " + response);
    failCount++;

    // Restart ESP32 jika gagal 5x berturut-turut
    if (failCount >= 5) {
      Serial.println("[System] Terlalu banyak kegagalan. Restart...");
      delay(2000);
      ESP.restart();
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("╔══════════════════════════════╗");
  Serial.println("║   ClimateOS ESP32 Firmware   ║");
  Serial.println("║   Device: " + String(DEVICE_ID) + "  ║");
  Serial.println("╚══════════════════════════════╝");

  // Inisialisasi sensor
  dht.begin();
  Serial.println("[Sensor] DHT22 diinisialisasi pada GPIO " + String(DHT_PIN));

  // Sambungkan ke WiFi
  connectWiFi();

  // Beri waktu sensor untuk stabil
  Serial.println("[System] Menunggu sensor stabil (3 detik)...");
  delay(3000);

  Serial.println("[System] ✓ Siap mengirim data setiap " + String(SEND_INTERVAL_MS / 1000) + " detik.");
}

// ─────────────────────────────────────────────────────────────
//  LOOP UTAMA
// ─────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // Kirim data setiap SEND_INTERVAL_MS milidetik
  if (now - lastSendTime >= SEND_INTERVAL_MS || lastSendTime == 0) {
    lastSendTime = now;

    float temperature, humidity;

    // Kedipkan LED saat proses baca+kirim
    digitalWrite(LED_PIN, LOW);

    if (readSensor(temperature, humidity)) {
      Serial.println("─────────────────────────────");
      Serial.println("[Sensor] Suhu     : " + String(temperature, 1) + " °C");
      Serial.println("[Sensor] Kelembaban: " + String(humidity, 1) + " %");

      bool success = sendTelemetry(temperature, humidity);

      // LED: nyala solid = OK, kedip cepat = gagal
      if (success) {
        digitalWrite(LED_PIN, HIGH);
      } else {
        for (int i = 0; i < 6; i++) {
          digitalWrite(LED_PIN, !digitalRead(LED_PIN));
          delay(150);
        }
      }
    } else {
      // Sensor gagal baca — kedip lambat
      for (int i = 0; i < 4; i++) {
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
        delay(400);
      }
    }
  }

  // Yield supaya watchdog timer tidak trigger
  delay(100);
}
