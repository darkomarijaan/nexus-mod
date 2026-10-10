# Nexus v0.5: Provider router (design)

- **Tanggal:** 2026-10-10
- **Status:** desain disetujui per bagian di chat; menunggu tinjauan spec ini
- **Versi target:** v0.5 (rencana "Jujur" bergeser ke v0.6, "Review" ke v0.7)

## 1. Latar belakang dan tujuan

Saat kuota langganan Claude (5 jam / mingguan) habis, pengguna memindahkan Claude Code ke provider lain dengan menukar `settings.json` (env `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, pemetaan model) ke sebuah hub. Itu butuh keluar dari sesi, mengedit file, dan menjalankan ulang; key tersimpan di `settings.json`; dan connector claude.ai ikut mati.

**Tujuan:** dari dalam sesi Claude Code, pengguna bisa memasukkan profil hub sendiri (URL, API key, model), berpindah antara Claude dan hub tanpa restart, dan ditawari pindah otomatis saat kuota Claude habis, dengan turn yang tertolak limit diulang di hub.

**Kriteria sukses**

1. Sesi yang dijalankan lewat `claude-nexus` bisa pindah Claude ↔ profil hub kapan saja tanpa restart dan tanpa menyentuh `settings.json`.
2. Saat Claude menolak karena limit paket, pengguna ditanya, dan kalau setuju turn berlanjut di hub tanpa putus.
3. Model hub bisa memakai semua tool Claude Code (Bash, Edit, Read, MCP, subagent).
4. Token login claude.ai tidak pernah terkirim ke hub; key hub tidak pernah ke Anthropic.
5. `claude` biasa tidak berubah sama sekali (Remote Control tetap hidup di sana).

**Di luar cakupan**

- Remote Control di sesi `claude-nexus` (tidak mungkin; lihat §2).
- Hub berformat OpenAI (`/v1/chat/completions`); hanya Anthropic Messages API.
- Kendali dari HP (fitur Telegram, ditunda; lihat memori proyek).
- Memasang launcher ke PATH secara otomatis.

## 2. Hasil uji kelayakan (2026-10-10)

| Uji | Hasil |
|---|---|
| Login claude.ai lewat proxy loopback yang meneruskan ke `api.anthropic.com` | Berhasil: `HEAD /api/hello` 200, `POST /v1/messages?beta=true` 200, tool Bash berjalan |
| `claude remote-control` dengan `ANTHROPIC_BASE_URL` ke proxy loopback | Ditolak: "Remote Control is only available when using Claude via api.anthropic.com…" (sesuai docs remote-control dan llm-gateway-connect) |
| Hook `turn.step` sebagai router | Tidak layak: input hook tidak membawa isi permintaan, dan skema input tool bawaan/MCP tidak bisa dibaca plugin |
| Hub `https://hub.example.com/v1` (OmniRoute): `/models` | 200, 19 model, mis. `antigravity/gemini-3.8-flash-tiered` |
| Hub: `/messages` format Anthropic, teks | 200, jawaban benar |
| Hub: tool use format Anthropic | `tool_use` Bash dengan input benar, `stop_reason=tool_use` |
| Hub: streaming | `text/event-stream` dengan `ping`, `message_start`, `content_block_*`, `message_delta`, `message_stop` |
| `claude -p` penuh dengan `ANTHROPIC_BASE_URL=<hub>` + model `antigravity/gemini-3.8-flash-tiered` | Menjalankan Bash dan menjawab benar |

Catatan dari uji end-to-end: dengan `ANTHROPIC_AUTH_TOKEN` connector claude.ai mati; nama model yang tidak dikenal katalog membuat Claude Code menganggap jendela konteks 200k.

## 3. Arsitektur

```
claude-nexus.cmd ──► bridge/claude-nexus.mjs (launcher, satu proses Node)
                        ├─ router (bridge/router.mjs, di dalam proses launcher)
                        │     127.0.0.1:<port acak>
                        │     ├─ rute "claude" ──► https://api.anthropic.com   (login claude.ai)
                        │     └─ rute "<profil>" ─► <URL hub>/messages          (key hub)
                        └─ child: claude  (env: ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, NEXUS_ROUTER_TOKEN)
                                 └─ Nexus (hooks) ──► /__nexus/* di router (rute, status, kejadian)
```

### 3.1 Launcher (`bridge/claude-nexus.mjs`, pembungkus `bin/claude-nexus.cmd` dan `bin/claude-nexus` untuk sh)

1. Membuat dua token acak (32 byte, hex): token inferensi dan token kontrol, lalu menyalakan router di `127.0.0.1` port acak.
2. Menjalankan `claude` dengan argumen yang diberikan pengguna (mis. `--resume <id>`), stdio diwariskan, dan env tambahan:
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
   - `ANTHROPIC_CUSTOM_HEADERS=x-nexus-router: <token inferensi>` (digabung dengan nilai yang sudah ada, dipisah baris baru)
   - `NEXUS_ROUTER_TOKEN=<token kontrol>`
3. Tidak mengisi `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, sehingga login claude.ai tetap menjadi kredensial (connector dan kuota langganan tetap jalan di rute Claude).
4. Keluar dengan kode keluar `claude`; router mati bersama proses launcher.

Satu router per sesi; sesi-sesi tidak berbagi state router.

### 3.2 Router (`bridge/router.mjs`, logika murni di `bridge/route-core.mjs`)

**Penerimaan permintaan**

- Hanya `Host` `127.0.0.1:<port>` / `localhost:<port>`; lainnya 403.
- Permintaan model wajib membawa `x-nexus-router: <token inferensi>`, endpoint `/__nexus/*` wajib membawa `x-nexus-control: <token kontrol>` (perbandingan aman-timing); tanpa itu 401. Kedua header dibuang sebelum diteruskan.

**Tabel rute** (rute aktif disimpan di memori router; default `claude`)

| Permintaan | Rute `claude` | Rute profil hub |
|---|---|---|
| `POST /v1/messages` (dengan/tanpa `?beta=true`) | `api.anthropic.com`, apa adanya | `<hub>/messages` dengan transformasi §3.3 |
| `POST /v1/messages/count_tokens` | `api.anthropic.com` | `<hub>/messages/count_tokens`; bila hub 404, kembalikan 404 (Claude Code memakai estimasi karakter) |
| Semua path lain (`/api/hello`, OAuth, dsb.) | `api.anthropic.com` | `api.anthropic.com` |
| `/__nexus/*` | endpoint kontrol (§3.4) | sama |

**Rute Claude**: header dan body diteruskan tanpa perubahan kecuali `host` dan pembuangan `x-nexus-router`; respons (termasuk `anthropic-ratelimit-unified-*`, `retry-after`, `x-should-retry`) dan SSE dialirkan apa adanya tanpa buffer.

### 3.3 Transformasi ke hub (di `route-core.mjs`, murni dan teruji)

- **Header (daftar izin):** `content-type`, `accept`, `anthropic-version`, `anthropic-beta` (tanpa nilai beta OAuth, mis. `oauth-*`). Ditambah `x-api-key: <key>` dan `authorization: Bearer <key>`. Semua header lain, termasuk `authorization` asli dan cookie, dibuang.
- **`model`:** dipetakan per tingkat. Tingkat ditentukan dari nama model Claude (`opus`, `sonnet`, `haiku`; tidak cocok → `sonnet`). Tingkat yang kosong di profil diisi model terisi pertama dengan urutan opus → sonnet → haiku.
- **Blok thinking:** ke hub, blok `thinking`/`redacted_thinking` pada pesan assistant dibuang. Ke Claude body tidak diubah: bila API menolak tanda tangan thinking dari riwayat campuran, Claude Code sendiri membuang blok thinking lama dan mengulang permintaan (docs llm-gateway-protocol, "Automatic retry and error forwarding").
- **ID tool:** hanya setelah sesi pernah memakai hub, ID `tool_use`/`tool_use_id` yang tidak cocok `^[a-zA-Z0-9_-]+$` diganti secara deterministik (karakter lain → `_`, sama di `tool_use` dan `tool_result`) sebelum dikirim ke Claude; body yang ID-nya sudah valid diteruskan byte demi byte.
- Field lain (system, tools, `cache_control`, metadata) tidak diubah.

### 3.4 Endpoint kontrol (`/__nexus/*`, wajib token kontrol, tanpa CORS)

| Endpoint | Fungsi |
|---|---|
| `GET /__nexus/status` | rute aktif (nama profil + model, tanpa key), jumlah permintaan per rute, permintaan yang sedang ditahan |
| `POST /__nexus/route` | `{ route: "claude" }` atau `{ route: "<nama>", profile: {hubUrl, apiKey, models, contextWindow} }`; key hanya disimpan di memori |
| `GET /__nexus/events?wait=25` | long-poll; mengembalikan kejadian `limit` (permintaan ditahan karena limit paket) atau `upstream-error` |
| `POST /__nexus/decision` | `{ id, action: "retry-on", route }` atau `{ id, action: "release" }` untuk permintaan yang ditahan |

## 4. Profil, pane, dan perintah

### 4.1 Profil

| Kolom | Aturan |
|---|---|
| `name` | unik, `[a-z0-9-]{1,32}`, bukan `claude` |
| `hubUrl` | `http(s)://…`, disimpan tanpa garis miring akhir; router memanggil `<hubUrl>/messages` |
| `apiKey` | wajib; ditampilkan tersamar (`sk-a…9f2c`) |
| `models.opus/sonnet/haiku` | minimal satu terisi |
| `contextWindow` | bilangan bulat ≥ 8000; default 200000 |
| `fallback` | `true` bila ditawarkan saat kuota habis; satu profil boleh `isDefault` |

Disimpan di `$.store` kunci `providers` (berlaku untuk semua proyek). Key tersimpan polos di store lokal, setara `ANTHROPIC_AUTH_TOKEN` di `settings.json`; tidak pernah ditulis ke log, transkrip, atau env.

### 4.2 Pane `/provider-nexus`

- Atas: rute aktif sesi (`● Claude (langganan)` / `● myhub · antigravity/gemini-3.8-flash-tiered`), atau petunjuk menjalankan `claude-nexus` bila sesi tanpa router.
- Daftar: entri Claude dan setiap profil, dengan tombol Pakai, Tes, Ubah, Hapus.
- Form tambah/ubah: Input untuk setiap kolom; tombol **Ambil daftar model** (GET `<hub>/models`, mengisi Select per tingkat; tetap bisa diketik manual); Simpan/Batal.
- **Tes**: satu permintaan `max_tokens: 16` per model terpetakan, menampilkan ✓/✗, waktu respons, dan pesan error; tes dilakukan langsung dari Nexus (`$.http.fetch`), jadi bisa juga di sesi tanpa router.
- Keterbatasan diketahui: elemen Input tidak punya mode password, jadi key terlihat saat diketik di pane.

### 4.3 Perintah dan HUD

- `/provider-nexus` (pane), `/provider-nexus use <nama>`, `/provider-nexus use claude`, `/provider-nexus status`; semua `immediate`.
- Saat rute hub aktif, segmen model HUD menjadi `⇄ <profil> · <model>`; bar kuota Claude tetap tampil.

## 5. Perpindahan

### 5.1 Manual

- Berlaku untuk permintaan model berikutnya, termasuk di tengah turn; permintaan yang sedang berjalan selesai di rute lama.
- Bila konteks sesi saat ini > 80% `contextWindow` profil tujuan, Nexus menawarkan compaction (`$.session.compact`) sebelum pindah.
- Selama rute hub aktif, Nexus memicu compaction sendiri saat konteks mencapai 85% `contextWindow` profil (dari `session.measure`).

### 5.2 Fallback saat kuota habis (`fallbackMode`: `ask` default, `auto`, `off`)

1. Di rute Claude, router mengenali 429 karena limit paket dari header `anthropic-ratelimit-unified-*`. Throttle sesaat (yang boleh di-retry) tidak ditahan.
2. Router menahan permintaan dan memancarkan kejadian `limit` (jendela mana, waktu reset).
3. Nexus (loop long-poll `/__nexus/events` sejak `session.start`):
   - `ask`: `$.ui.ask` "Limit 5 jam Claude habis (reset 1j 20m). Lanjutkan turn ini di <profil>?" dengan satu pilihan per profil `fallback` ditambah "Jangan pindah".
   - `auto`: langsung pindah ke profil default, toast.
4. Pindah → `POST /__nexus/route` lalu `decision retry-on`: router mengirim ulang permintaan yang ditahan ke hub dan mengalirkan hasilnya; turn berlanjut.
5. Tidak pindah, atau tidak ada keputusan dalam 120 detik → `release`: router meneruskan 429 asli.

### 5.3 Kembali ke Claude

Dari waktu reset kuota (data HUD), Nexus menawarkan sekali "Kuota Claude sudah pulih. Kembali ke Claude?"; perpindahan dilakukan di batas turn (`turn.complete`), tidak di tengah turn.

### 5.4 Integrasi dengan quota guard

Di sesi `claude-nexus` yang punya profil `fallback`, dialog quota guard 90% mendapat pilihan tambahan "Pindah ke <profil> sekarang".

### 5.5 Cakupan

Semua permintaan model sesi lewat router: percakapan utama, subagent, helper Nexus (`$.model.complete`/`fork`), ringkasan compaction.

## 6. Keamanan

1. Token claude.ai tidak pernah ke hub (daftar izin header, §3.3); key hub tidak pernah ke Anthropic.
2. Router: hanya `127.0.0.1`, pemeriksaan `Host`, token per peluncuran wajib di setiap permintaan, endpoint kontrol tanpa CORS dan tidak pernah mengembalikan key.
3. Dua token per peluncuran: **token inferensi** (header `x-nexus-router`, lewat `ANTHROPIC_CUSTOM_HEADERS`, wajib di permintaan model) dan **token kontrol** (header `x-nexus-control`, lewat `NEXUS_ROUTER_TOKEN`, wajib di `/__nexus/*`). Setelah membacanya di `session.start` (dan menyimpannya di state sesi agar selamat dari hot reload), Nexus mengosongkan `NEXUS_ROUTER_TOKEN` dengan `$.env.set`, sehingga tool tidak pernah bisa mengganti rute, membaca status, atau memutuskan permintaan yang ditahan. Token inferensi tetap terlihat oleh tool (Claude Code membutuhkannya di env); paling jauh tool bisa mengirim permintaan model lewat router. Key hub tidak pernah ada di env.
4. Log router: hanya metode, path, status, rute, durasi.
5. HUD selalu menampilkan `⇄` saat rute hub aktif (data dikirim ke hub dan provider di belakangnya). Shield dan sanitizer tetap berlaku.

## 7. Penanganan error

- Hub timeout/5xx/4xx: diteruskan apa adanya ke Claude Code (body error tidak diubah); Nexus menampilkan toast dengan nama profil dan menawarkan kembali ke Claude.
- Router tidak dapat dihubungi Nexus (mis. sesi bukan `claude-nexus`): fitur provider menampilkan petunjuk; tidak ada hook lain yang terpengaruh.
- Profil tidak valid: ditolak saat disimpan dengan pesan per kolom.

## 8. Pengujian

1. **Unit** (`node --test bridge/`, modul `route-core.mjs` tanpa Node API): validasi profil, pemetaan tingkat model, daftar izin header (bukti `authorization` dibuang), transformasi body (model, thinking dua arah, ID tool), klasifikasi 429 limit vs throttle, penyamaran key.
2. **Integrasi router** (`node --test`): router melawan Anthropic palsu dan hub palsu di localhost; SSE tidak dibuffer; hub palsu mencatat header (bukti token OAuth tidak bocor); 401/403 untuk token/Host salah; alur tahan-429 → retry di hub, → release, → timeout.
3. **Hook Nexus** (`claude plugin test`): pane dan key tersamar; `/provider-nexus use|status` (fetch dipalsukan); dialog fallback dan tawaran kembali; penanda HUD; pengosongan env; compaction di batas profil; petunjuk di sesi tanpa router.
4. **Uji langsung** dengan hub pengguna: rute Claude normal dengan kuota di HUD; pindah ke `myhub` di tengah sesi dan pemanggilan tool; kembali ke Claude dengan riwayat berisi turn hub; uji pengosongan `ANTHROPIC_CUSTOM_HEADERS`.
5. **Selesai bila:** semua tes lulus, type-check bersih, `claude plugin validate` lulus, README memuat bagian provider/launcher dan versi v0.5, uji langsung 1–4 berhasil, `nexus-mod.zip` dibangun ulang bila dirilis.

## 9. Risiko yang diverifikasi paling awal

1. Hub menerima permintaan Claude Code dalam mode login OAuth (beta OAuth dilepas) — uji e2e sebelumnya memakai mode `ANTHROPIC_AUTH_TOKEN`.
2. Riwayat campuran Claude ↔ hub (blok thinking, ID tool) diterima kedua sisi.
3. Claude Code mengirim header dari `ANTHROPIC_CUSTOM_HEADERS` pada setiap permintaan model (termasuk subagent dan compaction).
4. Peringatan "model tidak dikenal katalog" tidak muncul di rute hub (Claude Code tetap melihat nama model Claude; router yang mengganti).
5. Nilai persis header `anthropic-ratelimit-unified-*` yang membedakan limit paket dari throttle sesaat; dipastikan dari docs llm-gateway-protocol dan respons 429 sungguhan sebelum §5.2 diimplementasikan.

## 10. Berkas yang disentuh

- Baru: `bridge/claude-nexus.mjs`, `bridge/router.mjs`, `bridge/route-core.mjs`, `bin/claude-nexus.cmd`, `bin/claude-nexus`, `hooks/provider.ts` (logika murni profil/pane), `tests/provider.test.ts`, `bridge/*.test.mjs`.
- Diubah: `hooks/register.tsx` (perintah, pane, HUD, loop kejadian, fallback, quota guard), `hooks/config.ts` + `.claude-plugin/plugin.json` (`fallbackMode`), `types/index.d.ts` (state `provider`), `README.md` (bagian provider/launcher, versi v0.5, roadmap).
