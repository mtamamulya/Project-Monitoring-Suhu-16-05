# Panduan Firmware & Pembaruan Jarak Jauh

Satu berkas firmware untuk keenam unit. `DEVICE_ID` dan ukuran LCD disimpan di
memori alat, bukan di kode — jadi berkas `.bin` yang sama berlaku untuk semua.

Berkas: `Device4_Tama/RSND_Monitoring/RSND_Monitoring.ino`

---

## A. Flash pertama (sekali per unit)

### 1. Siapkan `secrets.h`

Ada di folder yang sama. Isi password WiFi RSND dan `DEVICE_API_KEY` yang sama
dengan di dashboard Render. Berkas ini tidak ikut ke GitHub.

### 2. Setel Arduino IDE

| Pengaturan | Nilai |
|---|---|
| Board | ESP32 Dev Module |
| **Partition Scheme** | **Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)** |
| Upload Speed | 921600 |

**Partition Scheme wajib yang ber-OTA.** ESP32 perlu ruang untuk menyimpan dua
versi sekaligus — versi yang berjalan dan versi yang sedang diunduh. Kalau
memakai skema tanpa OTA, pembaruan jarak jauh tidak akan bisa dipakai sama
sekali, dan itu baru ketahuan saat sudah terpasang di rumah sakit.

### 3. Flash, lalu isi identitas lewat Serial Monitor

Buka Serial Monitor **115200**, akhiran baris **Both NL & CR**. Ketik:

```
set id BERSALIN-01
set lcd 16x2
simpan
```

Alat menyala ulang dan siap. Perintah lain: `?` (bantuan), `tampil` (lihat
konfigurasi sekarang).

ID yang sah — salah ketik akan ditolak:
`BERSALIN-01` · `BERSALIN-02` · `OBAT-01` · `PERINATOLOGI-01` · `RAWATINAP-01` · `NURSESTATION-01`

Ukuran LCD: `20x4` atau `16x2`.

> Selama ID belum diisi, alat **tidak mengirim apa pun**. Ini disengaja: data
> tanpa ID yang sah akan ditolak server dan hanya membuang baterai.

### 4. Kalibrasi baterai (sekali per unit)

Lihat baris `[Baterai] vPin=...` di Serial Monitor, ukur baterai dengan
multimeter (DCV, 20V), lalu:

```
BATTERY_DIVIDER_RATIO = tegangan multimeter ÷ vPin
```

Ubah di kode, flash ulang. Unit pertama sudah dikalibrasi: **5,04**.

---

## B. Merilis pembaruan (setelah semua unit terpasang)

### 1. Naikkan nomor versi

Di `RSND_Monitoring.ino`:

```cpp
#define FW_VERSION "1.1.0"
```

Ini yang menjadi penanda. Kalau lupa dinaikkan, alat menganggap dirinya sudah
terbaru dan pembaruan tidak akan pernah jalan.

### 2. Bangun berkasnya

Arduino IDE → **Sketch → Export Compiled Binary**

Hasilnya `.bin` di folder sketch. Ganti namanya menyertakan versi, misalnya
`rsnd-1.1.0.bin`, supaya versi lama tidak tertimpa dan bisa dikembalikan kalau
ada masalah.

### 3. Unggah ke Firebase Hosting

Salin ke folder `public/firmware/` di proyek dashboard, lalu:

```
firebase deploy --only hosting
```

Alamatnya jadi:
`https://project-monitoring-suhu-b3ca4.web.app/firmware/rsnd-1.1.0.bin`

Berkas sengaja ditaruh di Firebase, **bukan** di Render. Render free tier
dibatasi jam hidup, dan melayani berkas ~1 MB akan menahan prosesnya selama
unduhan. Firebase Hosting memang untuk berkas statis — kuotanya 10 GB/bulan,
sementara enam alat sekali perbarui hanya memakai ~7 MB.

### 4. Umumkan lewat Render

Dashboard Render → Environment:

| Variabel | Nilai |
|---|---|
| `FIRMWARE_VERSION` | `1.1.0` |
| `FIRMWARE_URL` | `https://project-monitoring-suhu-b3ca4.web.app/firmware/rsnd-1.1.0.bin` |

Simpan. Render menyalakan ulang server, dan pada siklus kirim berikutnya keenam
alat mengetahui ada versi baru.

### 5. Pantau

Dashboard → **Admin → Setting → Versi Firmware Alat**. Tiap unit akan berpindah
dari *menunggu pembaruan* ke *terbaru* setelah selesai.

---

## C. Cara kerjanya, dan kenapa dirancang begini

Server hanya **mengumumkan** versi terbaru; keputusan memperbarui ada di alat.
Alasannya: hanya alat yang tahu sisa baterai dan kekuatan sinyalnya sendiri.

Alat menolak memperbarui kalau:

- **Baterai di bawah 50%** — pembaruan yang mati di tengah jalan bisa membuat
  alat tidak menyala, dan alat ini dipasang di ruangan rumah sakit
- **Sinyal WiFi di bawah −75 dBm** — unduhan besar di sinyal lemah rawan putus

Kalau ditolak, alat mencatat alasannya di Serial dan mencoba lagi nanti. Tidak
ada yang rusak, hanya tertunda.

Pengumuman versi menumpang balasan telemetri yang sudah ada — tidak menambah
request, dan tidak menambah waktu radio WiFi menyala.

---

## D. Kalau ada yang salah

**Alat tidak mengirim, Serial bilang "ID unit belum diatur"**
Belum diisi identitasnya. Ketik `set id <ID>` lalu `simpan`.

**Pembaruan tidak pernah jalan**
Periksa berurutan: `FIRMWARE_VERSION` di Render sudah berbeda dari `FW_VERSION`
di alat? Alamat `.bin` bisa dibuka di browser? Baterai di atas 50%? Cek Serial
Monitor — alasannya selalu dicetak di sana.

**Pembaruan gagal di tengah**
Alat tetap memakai versi lama dan mencoba lagi nanti. Ini perilaku normal, bukan
kerusakan.

**Alat tidak menyala setelah pembaruan**
Flash ulang lewat kabel seperti biasa. Konfigurasi ID dan LCD **tetap tersimpan**
di NVS — tidak perlu diisi ulang.

**Ingin mengubah ID atau ukuran LCD**
Tidak perlu flash ulang. Buka Serial Monitor, ketik perintahnya, lalu `simpan`.

---

## E. Kuota — apakah muat di paket gratis?

| | Kuota | Terpakai |
|---|---|---|
| Firebase Hosting — penyimpanan | 10 GB | ~1 MB per versi |
| Firebase Hosting — transfer | 10 GB/bulan | ~7 MB per rilis (6 alat) |
| Render — bandwidth | 100 GB/bulan | ~22 MB/bulan tambahan |
| Render — jam instance | 750 jam/bulan | **tidak bertambah sama sekali** |

Bahkan dengan rilis setiap hari, Firebase hanya terpakai sekitar 2% kuota
bulanan. Yang tetap membatasi adalah 750 jam instance Render — dan OTA tidak
menambah jam sedikit pun, karena tidak ada request baru ke Render.
