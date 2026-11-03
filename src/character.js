/**
 * Menampilkan karakter video (latar putih) di atas foto lobi.
 * Latar putih dihapus per frame sehingga karakter tampak benar-benar
 * berdiri di ruangan, bukan sebagai lapisan transparan.
 */
const video = document.getElementById('characterVideo');
const canvas = document.getElementById('characterCanvas');
if (video && canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = 540;
  const H = 960;
  canvas.width = W;
  canvas.height = H;

  const MIN_INTERVAL = 1000 / 30;
  let lastDraw = 0;

  function draw(now) {
    requestAnimationFrame(draw);
    if (now - lastDraw < MIN_INTERVAL) return;
    if (video.readyState < 2) return;
    lastDraw = now;

    ctx.drawImage(video, 0, 0, W, H);
    const frame = ctx.getImageData(0, 0, W, H);
    const d = frame.data;
    const MAX_DIST = 441.67;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const dr = 255 - r;
      const dg = 255 - g;
      const db = 255 - b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST;

      // Hanya piksel yang sangat dekat putih yang dibuat transparan,
      // dengan transisi halus agar tepi karakter tidak bergerigi.
      let a = (dist - 0.035) / 0.075;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      d[i + 3] = Math.round(a * 255);
    }

    ctx.putImageData(frame, 0, 0);
  }

  video.addEventListener('loadeddata', () => {
    video.play().catch(() => {});
  });
  requestAnimationFrame(draw);
}
