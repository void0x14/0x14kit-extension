# TransKit (0x14kit patched) — KURULUM

## Kurulum
1) Chrome: chrome://extensions
2) Sağ üst: Developer mode (Geliştirici modu) AÇIK
3) "Load unpacked" (Paketlenmemiş yükle) -> bu klasörü seç:
   /home/void0x14/ob2-recon/transkit-patched
4) Eski TransKit kuruluysa kaldır (çakışır). Ayarlar tek seferlik otomatik taşınır.

## Kullanım
- **Instant mode**: HER SİTEDE açıktır (kapatmak istediğine Ctrl+Shift+I ile o siteyi hariç tut).
  Yaz, kısa dur — öneri çıkınca **Enter** (gönder) veya **Tab** (uygula). Esc = vazgeç.
- **!! komut**: alan sonuna `!!en`, `!!tr`, `!!t` yaz → çevirir. (örn: `merhaba dünya !!en`)
- **Quote koruması**: reply'da alıntılanan metin ([quote]...[/quote], > satırları,
  <blockquote>) ASLA çevrilmez — sadece kendi yazdığın çevrilir.
- **Sağlayıcı**: yerel Chrome Built-in (Nano) varsayılan. Makinede Translator API yoksa
  otomatik Google Translate yedeği devreye girer. (API anahtarı gerekmez.)
- **Selection**: metni seç → 🔄 ikonuna tıkla.

## Test
transkit-tests/ dizininde: `node run-matrix.js` (60 senaryo), `node run-real.js` (gerçek siteler).
