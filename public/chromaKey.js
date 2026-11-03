/**
 * Green Screen (Chroma Key) Background Remover
 * Standalone script: applies chroma key to an existing <video> element.
 *
 * Usage:
 *   <script src="/chromaKey.js"></script>
 *   <script>
 *     window.ChromaKey.apply('#character-video', { keyColor: '#00ff00', similarity: 120, smoothness: 60, spill: 0.6 });
 *   </script>
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    keyColor: '#00ff00',
    similarity: 120,   // RGB distance below which pixel is considered green (0-442)
    smoothness: 60,    // transition band width
    spill: 0.6,        // spill suppression strength 0-1
    selector: 'video'
  };

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 255, b: 0 };
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h: h, s: s, v: v };
  }

  function apply(selectorOrVideo, opts) {
    const options = Object.assign({}, DEFAULTS, opts || {});
    const video = (typeof selectorOrVideo === 'string')
      ? document.querySelector(selectorOrVideo)
      : selectorOrVideo;
    if (!video) { console.warn('ChromaKey: video not found'); return null; }

    const key = hexToRgb(options.keyColor);

    const canvas = document.createElement('canvas');
    canvas.className = 'chroma-key-canvas';
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const parent = video.parentNode;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    canvas.style.position = 'absolute';
    canvas.style.top = video.offsetTop + 'px';
    canvas.style.left = video.offsetLeft + 'px';
    canvas.style.width = video.offsetWidth + 'px';
    canvas.style.height = video.offsetHeight + 'px';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '5';
    canvas.style.backgroundImage = 'linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)';
    canvas.style.backgroundSize = '16px 16px';
    canvas.style.backgroundPosition = '0 0,0 8px,8px -8px,-8px 0';
    parent.insertBefore(canvas, video.nextSibling);

    video.style.opacity = '0';

    let rafId = null;
    let running = true;

    function resize() {
      const w = video.videoWidth || video.offsetWidth || 640;
      const h = video.videoHeight || video.offsetHeight || 360;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.style.top = video.offsetTop + 'px';
      canvas.style.left = video.offsetLeft + 'px';
      canvas.style.width = video.offsetWidth + 'px';
      canvas.style.height = video.offsetHeight + 'px';
    }

    function frame() {
      if (!running) return;
      if (video.readyState >= 2) {
        resize();
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        const sim = options.similarity;
        const smooth = options.smoothness;
        const spill = options.spill;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const dr = r - key.r, dg = g - key.g, db = b - key.b;
          const rgbDist = Math.sqrt(dr * dr + dg * dg + db * db);
          let a1;
          if (rgbDist <= sim) a1 = 0;
          else if (rgbDist >= sim + smooth) a1 = 1;
          else a1 = (rgbDist - sim) / smooth;

          const hsv = rgbToHsv(r, g, b);
          let greenAlpha = 1;
          if (hsv.h > 60 && hsv.h < 180 && hsv.s > 0.12 && hsv.v > 0.12) {
            let hd = Math.abs(hsv.h - 120);
            if (hd > 180) hd = 360 - hd;
            const hf = 1 - Math.min(hd / 60, 1);
            const gs = hf * hsv.s * hsv.v;
            if (gs >= 0.25) greenAlpha = 0;
            else if (gs <= 0.05) greenAlpha = 1;
            else greenAlpha = 1 - (gs - 0.05) / 0.20;
          }

          let alpha = Math.min(a1, greenAlpha);
          // spill suppression
          if (alpha < 1) {
            const spillAmt = (1 - alpha) * spill;
            const excess = Math.max(0, g - (r + b) * 0.5);
            d[i + 1] = Math.max(0, g - spillAmt * excess);
          }
          d[i + 3] = Math.round(alpha * 255);
        }
        ctx.putImageData(img, 0, 0);
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);

    return {
      stop: function () { running = false; if (rafId) cancelAnimationFrame(rafId); },
      canvas: canvas
    };
  }

  function auto() {
    const v = document.querySelector(DEFAULTS.selector);
    if (v) apply(v, {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    setTimeout(auto, 0);
  }

  global.ChromaKey = { apply: apply, defaults: DEFAULTS };
})(window);
