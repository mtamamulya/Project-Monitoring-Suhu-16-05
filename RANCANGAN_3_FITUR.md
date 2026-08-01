# Rancangan 3 Perubahan Besar

Dokumen ini rancangan saja — belum ada kode yang diubah. Tujuannya supaya
keputusan desain disepakati dulu sebelum dieksekusi, karena satu di antaranya
(PDF replika) bergantung pada jawaban RSND dan salah tebak berarti kerja ulang.

---

## A. PDF laporan meniru formulir kertas RSND

### Keadaan sekarang vs yang diminta

PDF sekarang: grafik garis Chart.js biasa + tabel data. Bentuknya lazim untuk
dashboard, tapi **sama sekali tidak menyerupai** formulir kertas yang dipakai RSND.

Formulir kertas RSND sebenarnya berupa **kertas grafik berpetak**, bukan grafik
garis biasa. Perbedaannya besar dan tidak bisa dicapai dengan menyetel Chart.js.

### Anatomi formulir kertas (dibaca dari foto)

```
┌──────────────────────────────────────────────────────────────────┐
│ [logo RSND]   GRAFIK MONITORING SUHU      BULAN: ___ TAHUN: ___  │
├──────────────────────────────────────────────────────────────────┤
│      │ 1  │ 2  │ 3  │ ...                              │ 31 │    │  <- tanggal
│      │P S M│P S M│P S M│                              │P S M│    │  <- shift
│ 26°  ├─┼─┼─┼─┼─┼─┼─┼─┼─┤ ... petak ...                │    │    │
│ 24°  │ │ │ │ │ │ │ │ │ │                              │    │    │
│ 22°  │ │ │●│ │ │ │ │ │ │   titik + garis merah        │    │    │
│ 20°  │ │ │ │ │ │ │ │ │ │                              │    │    │
│ 18°  └─┴─┴─┴─┴─┴─┴─┴─┴─┘                              │    │    │
│ Nama │ ᶠᵈ │ ᵍʰ │ ᵏˡ │  ... paraf tulis tangan tiap kolom ...     │
│ Paraf│    │    │    │                                            │
├──────────────────────────────────────────────────────────────────┤
│ (blok yang sama untuk GRAFIK MONITORING KELEMBABAN, 40%–60%)     │
├─────────────────────────┬────────────────────────────────────────┤
│ KETERANGAN:             │ TGL │ SUHU/      │ ANALISIS │ TINDAKAN │
│ 1. Ketentuan: batas ... │     │ KELEMBABAN │          │ DAN HASIL│
│ 2. Bubuhkan titik ...   │     │            │          │          │
│ 3. Tarik garis ...      │     │            │          │ PETUGAS  │
│ 4. Petugas menuliskan.. │     │            │          │ YG MELA- │
│ 5. Jika di luar batas.. │     │            │          │ PORKAN   │
└─────────────────────────┴─────┴────────────┴──────────┴──────────┘
```

Isi KETERANGAN yang terbaca di foto:

1. Ketentuan: batas normal suhu penyimpanan 15–25 °C, kelembaban udara 45–55%
   (Permenkes RI No. 72 Tahun 2016)
2. Bubuhkan titik pada kolom suhu dan kelembaban pada tanggal yang sesuai
   setiap shift Pagi, Siang, Malam
3. Tarik garis dari hari sebelumnya hingga membuat satu garis (menggunakan tinta merah)
4. Petugas menuliskan nama dan paraf pada kolom petugas
5. Jika suhu berada di luar batas normal, petugas segera menghubungi IPSRS

### Perbedaan teknis yang menentukan cara mengerjakannya

| | Grafik sekarang | Formulir kertas |
|---|---|---|
| Sumbu X | hanya tanggal yang ada datanya | **selalu 31 tanggal × 3 shift = 93 kolom**, terisi maupun tidak |
| Sumbu Y | otomatis mengikuti data | **tetap**: suhu 18–26 °C, kelembapan 40–60% |
| Latar | kosong | **petak penuh**, seperti kertas milimeter |
| Paraf | tidak ada | **satu paraf per kolom shift**, di bawah grafik |
| Keterangan | tidak ada | kotak 5 butir aturan |
| Analisis | tidak ada | tabel terpisah di bawah |

Karena sumbu X harus **selalu 93 kolom** walau datanya baru 6 entri, dan latarnya
harus berpetak, Chart.js bukan alat yang tepat. Menyetelnya sampai menyerupai ini
akan lebih rumit daripada menggambar sendiri.

### Cara yang saya sarankan

**Gambar sendiri dengan HTML + CSS, lalu cetak lewat `window.print()`** — sama
seperti mekanisme PDF yang sekarang, jadi tidak menambah beban server Render dan
tidak menambah pustaka baru.

Alasannya: petak, kolom tetap, dan tabel adalah hal yang justru mudah dan presisi
dengan CSS Grid, sementara sangat sulit dipaksakan ke pustaka grafik. Garis merah
penghubung titik digambar sebagai satu elemen SVG yang ditumpuk di atas petak.

Alternatif yang saya pertimbangkan lalu tolak:
- *Chart.js disetel habis-habisan* — bisa mendekati, tapi kode jadi rumit dan
  rapuh; menambah 1 shift saja bisa merusak tata letak.
- *PDF dibuat di server (ReportLab)* — hasil paling presisi, tapi menambah
  pustaka berat, menambah beban Render yang sudah kena limit, dan PDF-nya jadi
  bergantung server hidup. Tidak sepadan.

### Keputusan RSND (sudah dijawab)

**1. Sumbu Y mengikuti data.** Bukan tetap 18–26 °C. Kalau ada pembacaan 30 °C,
sumbu diperluas supaya 30 tetap tergambar dan bisa dicatat.

Aturan yang saya turunkan dari keputusan ini:

```
batas_bawah = pembulatan ke bawah kelipatan 2 dari min(15, nilai terendah bulan itu)
batas_atas  = pembulatan ke atas  kelipatan 2 dari max(25, nilai tertinggi bulan itu)
```

Garis batas standar (15 dan 25 °C) **selalu** dipaksa masuk walau data bulan itu
seluruhnya di tengah — kalau tidak, pembaca kehilangan acuan. Langkah antarbaris
tetap 2° seperti kertas asli. Untuk kelembapan, acuan yang selalu masuk adalah
45% dan 55%, langkah 2%.

Batas pengaman: kalau rentangnya melebar sampai lebih dari 16 baris (mis. ada data
3 °C dan 34 °C sekaligus), langkah dinaikkan jadi 4° supaya petak tidak jadi rapat
tak terbaca.

**2. Blok merah = hari Minggu.** Bukan penanda penyimpangan, dan bukan hari libur —
data tetap dibaca dan dicatat pada hari itu. Jadi murni penanda kalender: setiap
tanggal yang jatuh pada Minggu diberi blok merah selebar 3 kolom (P/S/M),
membentang penuh dari atas ke bawah petak.

Ini melegakan, karena artinya blok merah **dihitung dari kalender**, bukan dari
data — jadi tetap muncul walau tanggal itu belum diisi.

**3. Paraf diperkecil, meniru gambar.** Tanda tangan digital dikecilkan sampai
seukuran paraf tulis tangan di kolomnya.

**4. Kertas A4.**

### Hitungan tata letak A4 lanskap

```
Kertas            : 297 × 210 mm
Area cetak        : 281 × 194 mm   (margin 8 mm)
Kolom label sumbu : 16 mm
Lebar area petak  : 265 mm
Jumlah kolom      : 93   (31 tanggal × 3 shift)
Lebar per kolom   : 2,85 mm
Lebar per tanggal : 8,55 mm
```

### Dua kenyataan yang muncul dari hitungan itu

**(i) Tinggi halaman pas-pasan sampai nol.** Kalau kop, dua grafik, dua baris
paraf, kotak keterangan, dan tabel analisis semuanya dipaksa ke satu halaman,
totalnya persis 194 mm dari 194 mm yang tersedia — tanpa sisa sama sekali. Itu
terlalu rapat; sedikit perbedaan font atau penyetelan printer akan membuatnya
tumpah ke halaman kedua secara acak dan berantakan.

Rencana saya: **halaman 1** berisi kop, kedua grafik, kedua baris paraf, dan kotak
keterangan. **Halaman 2** berisi tabel Analisis / Tindakan dan Hasil. Tabel itu
memang untuk diisi tangan saat ada penyimpangan, jadi justru butuh ruang lapang,
bukan diselipkan di sisa halaman.

**(ii) Tanda tangan akan jadi coretan kecil — dan itu memang wajar.** Kanvas tanda
tangan sekarang berbentuk melebar (420 × 150 piksel, rasio 2,8 : 1). Kalau
dipaskan setinggi 7 mm, lebarnya jadi 19,6 mm — meluber sampai 7 kolom shift.

Dua penyesuaian supaya tetap masuk:

- **Potong ke area bertinta lebih dulu.** Kebanyakan orang menandatangani hanya di
  sebagian kanvas, sisanya kosong. Memotong ke area yang benar-benar ada coretannya
  membuat rasionya jauh lebih ringkas sebelum diperkecil. Ini perlu dilakukan
  bagaimanapun, bukan cuma untuk kasus ini.
- **Diskalakan mengikuti lebar kolom**, tinggi menyesuaikan.

Hasilnya memang akan seperti paraf tulis tangan di formulir asli: kecil, tidak
terbaca satu per satu — dan itu wajar, karena fungsinya penanda kehadiran petugas,
bukan untuk dibaca. Tapi supaya tetap bisa diperiksa kalau ada yang dipertanyakan,
saya tambahkan **daftar paraf ringkas** di bawah keterangan: nama verifikator yang
mengisi bulan itu, masing-masing dengan tanda tangannya dalam ukuran normal.

Saran tambahan untuk ke depan: bentuk kanvas tanda tangan dibuat lebih persegi
(mis. 240 × 150), supaya tanda tangan yang dibuat setelahnya secara alami lebih
ringkas saat dicetak kecil. Tidak memengaruhi tanda tangan yang sudah tersimpan.

### Perkiraan pekerjaan

Ini yang terbesar dari tiga tugas: menggambar petak, memetakan nilai ke posisi
kolom yang benar, garis penghubung, blok Minggu, baris paraf, kotak keterangan,
dan tabel analisis — plus penyetelan agar hasil cetaknya benar-benar rapi di A4.

---

## B. Suhu & kelembapan terisi otomatis dari sensor

### Yang diminta

Perawat tidak lagi mengetik angka. Cukup memilih nama dan menandatangani.

### Rancangan

Saat halaman Kepatuhan dibuka, sistem mengambil pembacaan terkini dari sensor
ruangan itu dan mengisi kedua kolom otomatis. Di sebelahnya ditampilkan jelas:

```
Suhu        [ 22.4 ]  °C     ← dari sensor, pukul 07:03
Kelembapan  [ 51.2 ]  %      ← dari sensor, pukul 07:03
                              [ Ambil ulang dari sensor ]
```

Kolomnya **tetap bisa diubah**. Ini penting: kalau sensor rusak, atau petugas
mengukur dengan termometer terpisah, angka manual harus tetap bisa dimasukkan.

### Yang harus dicatat demi keabsahan audit

Ini bagian yang menurut saya paling perlu dipikirkan, dan bukan sekadar teknis.

Kalau angkanya diisi mesin, **apa yang sebenarnya diverifikasi perawat?**
Jawabannya: bahwa ia hadir mengecek pada waktu itu dan menyaksikan angka tersebut.
Tanda tangannya tetap bermakna. Tapi laporan harus **jujur** menyatakan bahwa
angka itu berasal dari sensor, bukan dibaca dari alat ukur terpisah — kalau tidak,
auditor bisa menganggap ada pencatatan yang tidak sesuai kenyataan.

Karena itu ditambahkan field baru pada tiap entri verifikasi:

| Field baru | Isi | Gunanya |
|---|---|---|
| `sumber_nilai` | `"sensor"` atau `"manual"` | membedakan angka otomatis dan angka ketikan |
| `sensor_waktu` | waktu pembacaan sensor | membuktikan angka tidak diambil dari jam lain |
| `sensor_status` | `"online"` / `"offline"` | menjelaskan kenapa suatu entri terpaksa manual |

### Keadaan khusus yang harus ditangani

**Sensor sedang mati.** Kolom tidak diisi otomatis, muncul peringatan jelas, dan
perawat wajib mengisi manual. Entri ditandai `sumber_nilai: manual`. Sistem tidak
boleh diam-diam memakai angka lama — itu akan menjadi catatan palsu.

**Diisi jauh dari jam shift.** Kalau shift Pagi (07:00) baru diisi pukul 11:00,
angka sensornya adalah angka pukul 11:00. Sistem sebaiknya memberi tahu:
"Anda mengisi shift Pagi pada pukul 11:00." Bukan menolak — hanya memastikan
petugas sadar, dan tercatat apa adanya.

**Data sensor basi.** Kalau pembacaan terakhir sudah lebih dari 15 menit, jangan
dipakai sebagai "terkini" tanpa peringatan.

---

## C. Mencegah pembacaan ngawur DHT22

### Masalahnya

DHT22 memang bermasalah pada dua keadaan:
- **Saat baru menyala** — sensor butuh sekitar 2 detik sebelum bisa dibaca, dan
  pembacaan pertama sering berupa nilai sampah (mendekati nol) atau gagal.
- **Sesekali saat berjalan** — kegagalan checksum menghasilkan lonjakan nilai yang
  jauh dari kenyataan.

Kode sekarang hanya memeriksa `isnan()`. Itu menangkap kegagalan total, tapi
**tidak menangkap nilai sampah yang secara teknis berupa angka sah** — misalnya
1,2 °C. Inilah celah yang kamu maksud.

### Rancangan — lima lapis, dari sensor sampai server

**Lapis 1 — masa pemanasan.** Selama 30 detik pertama setelah alat menyala, sensor
dibaca tapi **tidak dikirim ke server**. LCD menampilkan "Pemanasan…". Pengiriman
baru dimulai setelah ada 3 pembacaan sah berturut-turut.

**Lapis 2 — median dari beberapa sampel.** Alih-alih membaca sekali, baca 5 kali
dengan jeda 2,5 detik lalu ambil nilai tengahnya. Satu lonjakan liar otomatis
terbuang karena tidak pernah menjadi nilai tengah. Ini lapis paling ampuh dan
paling murah.

**Lapis 3 — batas fisik.** Tolak pembacaan di luar 5–50 °C atau 10–99% RH. Ruangan
rumah sakit tidak mungkin di luar rentang itu; kalau terbaca demikian, sensornya
yang salah.

**Lapis 4 — batas laju perubahan.** Tolak kalau melompat lebih dari 5 °C atau 15%
dari pembacaan sah terakhir dalam satu selang. Suhu ruangan tidak bisa berubah
sedrastis itu dalam 1 menit — kalau terjadi, hampir pasti kesalahan baca.

**Lapis 5 — pengetatan di server.** Batas server sekarang −50…100 °C, terlalu
longgar sehingga 1,2 °C tetap lolos. Diperketat menjadi 0–60 °C, sebagai jaring
terakhir kalau firmware lama belum sempat diperbarui.

### Yang perlu diperhatikan

Semua penolakan harus **tercatat di log**, bukan dibuang diam-diam. Sensor yang
sering ditolak berarti mulai rusak dan perlu diganti — itu informasi berharga,
bukan gangguan. Kalau berturut-turut gagal lebih dari 10 kali, alat sebaiknya
melaporkan dirinya bermasalah agar teknisi tahu.

Satu hal yang **tidak** boleh dilakukan: menghaluskan data dengan rata-rata
bergerak panjang. Untuk pemantauan medis, lonjakan asli (AC mati mendadak) harus
tetap terlihat apa adanya. Median 5 sampel dalam 12 detik cukup membuang derau
tanpa menyembunyikan kejadian nyata.

---

## Urutan pengerjaan yang saya sarankan

1. **C — filter DHT22.** Berdiri sendiri, tidak bergantung apa pun, dan harus
   sudah beres sebelum sensor dipasang. Kalau tidak, data ngawur terlanjur masuk
   database dan mengotori laporan akreditasi.
2. **B — isi otomatis dari sensor.** Butuh sensor yang sudah bisa dipercaya, jadi
   setelah C.
3. **A — PDF replika.** Terbesar, dan **menunggu jawaban RSND** atas empat
   pertanyaan di atas.

Mengerjakan A lebih dulu berisiko: kalau ternyata sumbu Y atau arti blok merah
berbeda dari tebakan, sebagian besar pekerjaannya dibongkar ulang.
