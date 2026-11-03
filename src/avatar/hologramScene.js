import * as THREE from 'three';
import { getSpeechClock } from '../voice/speechSynthesis.js';

const BACKGROUND_PATH = './public/background.png';
const CHARACTER_FRAME = { width: 944, height: 944 };

const MOUTH_MIN_HOLD_MS = 85;
const MOUTH_MIN_SEGMENT_S = 0.09;

export class HologramScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'IDLE';
    this.speaking = false;
    this.speechSchedule = [];
    this.scheduleStartedAt = 0;
    this.currentMouthShape = 'closed';
    this.targetMouthShape = 'closed';
    this.blendFromShape = 'closed';
    this.blendProgress = 1;
    this.lastShapeChangeAt = 0;
    this.scheduleDuration = 0;
    this.energySmooth = 0;
    this.lastAppliedAt = 0;
    this.previousFrameTime = performance.now();

    this.textureLoader = new THREE.TextureLoader();
    this.poseTextures = {};
    this.materials = [];
    this.transitioning = false;
    this.transitionStart = 0;
    this.transitionDuration = 2000;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.2, -1.2, 0.1, 100);
    this.camera.position.set(0, 0, 5);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.backgroundMesh = null;
    this.backgroundTexture = null;
    this.backgroundAspect = 941 / 1672;
    this.createBackground();

    this.character = this.createIllustration();
    this.scene.add(this.character);

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);

    this.running = true;
    this.animate();
  }

  createBackground() {
    const material = new THREE.MeshBasicMaterial({ depthWrite: false });
    this.backgroundMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.backgroundMesh.name = 'Latar resepsionis';
    this.backgroundMesh.position.z = -0.05;
    this.backgroundMesh.renderOrder = 0;
    this.scene.add(this.backgroundMesh);
    this.materials.push(material);

    this.textureLoader.load(BACKGROUND_PATH, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      this.backgroundTexture = texture;
      if (texture.image?.width && texture.image?.height) {
        this.backgroundAspect = texture.image.width / texture.image.height;
      }
      material.map = texture;
      material.needsUpdate = true;
      this.updateBackgroundLayout();
    }, undefined, () => {
      material.color.set(0x0a1520);
    });
  }

  updateBackgroundLayout() {
    if (!this.backgroundMesh) return;
    const viewHeight = 2.45;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const viewWidth = viewHeight * rect.width / rect.height;
    const viewAspect = viewWidth / viewHeight;
    const texAspect = this.backgroundAspect || 1;
    let planeW = viewWidth;
    let planeH = viewHeight;
    if (viewAspect > texAspect) {
      planeW = viewWidth;
      planeH = viewWidth / texAspect;
    } else {
      planeH = viewHeight;
      planeW = viewHeight * texAspect;
    }
    this.backgroundMesh.position.y = -viewHeight * 0.06;
    this.backgroundMesh.scale.set(planeW, planeH, 1);
  }

  createIllustration() {
    const root = new THREE.Group();
    root.name = 'Karakter Video PUPR';

    this.characterAspect = 9 / 16;
    const imageWidth = 3.55;

    const makeVideo = (src) => {
      const video = document.createElement('video');
      video.src = src;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.crossOrigin = 'anonymous';
      return video;
    };

    this.videos = {
      standby: makeVideo('./public/karakter_baru/stanby.mp4'),
      speaking: makeVideo('./public/video.mp4')
    };
    this.textures = {
      standby: new THREE.VideoTexture(this.videos.standby),
      speaking: new THREE.VideoTexture(this.videos.speaking)
    };
    for (const tex of Object.values(this.textures)) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
    }

    const playPromise = this.videos.standby.play();
    if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});

    this.video = this.videos.standby;
    this.videoTexture = this.textures.standby;
    this.activeVideoKey = 'standby';

    const vertexShader = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
    const fragmentShader = [
      'uniform sampler2D map;',
      'uniform vec3 keyColor;',
      'uniform float similarity;',
      'uniform float smoothness;',
      'uniform float spill;',
      'varying vec2 vUv;',
      'vec3 rgb2hsv(vec3 c){',
      '  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);',
      '  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));',
      '  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));',
      '  float d = q.x - min(q.w, q.y);',
      '  float e = 1.0e-10;',
      '  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);',
      '}',
      'void main(){',
      '  vec4 tex = texture2D(map, vUv);',
      '  float d = distance(tex.rgb, keyColor);',
      '  float a1 = smoothstep(similarity, similarity + smoothness, d);',
      '  vec3 hsv = rgb2hsv(tex.rgb);',
      '  float hue = hsv.x * 360.0;',
      '  float sat = hsv.y;',
      '  float val = hsv.z;',
      '  float greenAlpha = 1.0;',
      '  if (hue > 60.0 && hue < 180.0 && sat > 0.12 && val > 0.12) {',
      '    float hd = abs(hue - 120.0);',
      '    if (hd > 180.0) hd = 360.0 - hd;',
      '    float hf = 1.0 - clamp(hd / 60.0, 0.0, 1.0);',
      '    float gs = hf * sat * val;',
      '    greenAlpha = 1.0 - smoothstep(0.05, 0.25, gs);',
      '  }',
      '  float alpha = min(a1, greenAlpha);',
      '  vec3 color = tex.rgb;',
      '  float spillAmount = (1.0 - alpha) * spill;',
      '  color.g = color.g - spillAmount * max(0.0, color.g - (color.r + color.b) * 0.5);',
      '  color = clamp(color, 0.0, 1.0);',
      '  gl_FragColor = vec4(color, tex.a * alpha);',
      '}'
    ].join('\n');

    const geometry = new THREE.PlaneGeometry(imageWidth, imageWidth);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.videoTexture },
        keyColor: { value: new THREE.Color(0x00ff00) },
        similarity: { value: 0.32 },
        smoothness: { value: 0.12 },
        spill: { value: 0.6 }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.materials.push(material);

    this.characterMesh = new THREE.Mesh(geometry, material);
    this.characterMesh.name = 'Video karakter';
    this.characterMesh.scale.y = this.characterAspect;

    const overlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.videoTexture },
        keyColor: { value: new THREE.Color(0x00ff00) },
        similarity: { value: 0.32 },
        smoothness: { value: 0.12 },
        spill: { value: 0.6 }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0,
      side: THREE.DoubleSide
    });
    this.materials.push(overlayMaterial);
    this.characterOverlay = new THREE.Mesh(geometry.clone(), overlayMaterial);
    this.characterOverlay.name = 'Video karakter blend';
    this.characterOverlay.position.z = 0.002;
    this.characterOverlay.visible = false;
    this.characterOverlay.scale.y = this.characterAspect;

    root.add(this.characterMesh);
    root.add(this.characterOverlay);
    root.position.y = -0.34;
    this.enableCharacterDragging(root, this.characterMesh, imageWidth, imageWidth * this.characterAspect);

    for (const v of Object.values(this.videos)) {
      v.addEventListener('loadedmetadata', () => {
        if (v.videoWidth && v.videoHeight) {
          this.characterAspect = v.videoHeight / v.videoWidth;
          this.characterMesh.scale.y = this.characterAspect;
          this.characterOverlay.scale.y = this.characterAspect;
          this.resize();
        }
      });
    }

    return root;
  }

  enableCharacterDragging(root, characterMesh, imageWidth, imageHeight) {
    const storageKey = 'pupr-avatar-character-position-v4';
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const worldPoint = new THREE.Vector3();
    const dragOffset = new THREE.Vector2();
    let dragging = false;

    const clampPosition = (x, y) => ({
      x: THREE.MathUtils.clamp(x, -imageWidth / 2, imageWidth / 2),
      y: THREE.MathUtils.clamp(y, -imageHeight / 2, imageHeight / 2)
    });
    const updateRay = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, this.camera);
    };
    const pointOnPortrait = (event) => {
      updateRay(event);
      return raycaster.ray.intersectPlane(dragPlane, worldPoint);
    };

    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        const position = clampPosition(saved.x, saved.y);
        root.position.set(position.x, position.y, root.position.z);
      }
    } catch {
      // Posisi default tetap digunakan jika penyimpanan browser tidak tersedia.
    }

    this.onCharacterPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      updateRay(event);
      if (!raycaster.intersectObject(characterMesh, false).length || !pointOnPortrait(event)) return;
      dragging = true;
      dragOffset.set(root.position.x - worldPoint.x, root.position.y - worldPoint.y);
      this.canvas.classList.add('dragging-character');
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    this.onCharacterPointerMove = (event) => {
      if (dragging) {
        if (!pointOnPortrait(event)) return;
        const position = clampPosition(worldPoint.x + dragOffset.x, worldPoint.y + dragOffset.y);
        root.position.set(position.x, position.y, root.position.z);
        return;
      }
      updateRay(event);
      this.canvas.classList.toggle('character-draggable', raycaster.intersectObject(characterMesh, false).length > 0);
    };
    this.onCharacterPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      this.canvas.classList.remove('dragging-character');
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      try {
        localStorage.setItem(storageKey, JSON.stringify({ x: root.position.x, y: root.position.y }));
      } catch {
        // Penggeseran tetap aktif walau penyimpanan browser tidak tersedia.
      }
    };

    this.canvas.addEventListener('pointerdown', this.onCharacterPointerDown);
    this.canvas.addEventListener('pointermove', this.onCharacterPointerMove);
    this.canvas.addEventListener('pointerup', this.onCharacterPointerUp);
    this.canvas.addEventListener('pointercancel', this.onCharacterPointerUp);
  }

  visemeForChar(char) {
    if (!char || char.trim() === '') return null;
    if (/[.,!?;:…]/.test(char)) return { shape: 'closed', weight: 0.55, vowel: false };
    const c = char.toLowerCase();
    if (c === 'a') return { shape: 'a', weight: 1.7, vowel: true };
    if (c === 'e' || c === 'é' || c === 'è') return { shape: 'e', weight: 1.45, vowel: true };
    if (c === 'i') return { shape: 'i', weight: 1.4, vowel: true };
    if (c === 'o') return { shape: 'o', weight: 1.55, vowel: true };
    if (c === 'u') return { shape: 'u', weight: 1.5, vowel: true };
    if (/[mbp]/.test(c)) return { shape: 'm', weight: 0.72, vowel: false };
    if (/[fv]/.test(c) || c === 's' || c === 'z' || c === 'c' || c === 'j') return { shape: 's', weight: 0.62, vowel: false };
    if (/[tdnlr]/.test(c)) return { shape: 'l', weight: 0.55, vowel: false };
    return null;
  }

  makeMouthSchedule(text, duration) {
    const safeDuration = Math.max(0.4, duration || 1.5);
    const raw = [];
    for (const char of (text || '').toLowerCase()) {
      const viseme = this.visemeForChar(char);
      if (!viseme) continue;
      const last = raw[raw.length - 1];
      if (last && last.shape === viseme.shape) {
        last.weight += viseme.weight;
        last.vowel = last.vowel || viseme.vowel;
      } else {
        raw.push({ ...viseme });
      }
    }
    if (!raw.length) return [{ shape: 'e', start: 0, end: safeDuration }];
    const totalWeight = raw.reduce((sum, segment) => sum + segment.weight, 0) || 1;
    let time = 0;
    const timed = raw.map((segment) => {
      const start = time;
      const span = safeDuration * segment.weight / totalWeight;
      time += span;
      return { shape: segment.shape, vowel: segment.vowel, start, end: time };
    });
    const merged = [];
    for (const segment of timed) {
      const last = merged[merged.length - 1];
      const span = segment.end - segment.start;
      const lastSpan = last ? last.end - last.start : 0;
      const swallow = last && last.shape !== segment.shape && !segment.vowel && !last.vowel && (span < MOUTH_MIN_SEGMENT_S || lastSpan < MOUTH_MIN_SEGMENT_S);
      if (last && (last.shape === segment.shape || swallow)) {
        last.end = segment.end;
        if (segment.vowel) last.shape = segment.shape;
      } else {
        merged.push({ shape: segment.shape, start: segment.start, end: segment.end });
      }
    }
    return merged.length ? merged : [{ shape: 'e', start: 0, end: safeDuration }];
  }

  rescaleSchedule(duration) {
    const next = Math.max(0.4, duration || 0);
    if (!this.speechSchedule.length || !this.scheduleDuration) {
      this.scheduleDuration = next;
      return;
    }
    if (Math.abs(next - this.scheduleDuration) < 0.04) return;
    const scale = next / this.scheduleDuration;
    for (const segment of this.speechSchedule) {
      segment.start *= scale;
      segment.end *= scale;
    }
    this.scheduleDuration = next;
  }

  setSpeechText(text, duration) {
    const safeDuration = Math.max(0.4, duration || 1.5);
    this.scheduleDuration = safeDuration;
    this.speechSchedule = this.makeMouthSchedule(text, safeDuration);
    this.scheduleStartedAt = performance.now();
    this.energySmooth = 0.2;
    this.targetMouthShape = 'closed';
    this.lastAppliedAt = 0;
  }

  setSpeechWord() {}

  shapeAtTime(time) {
    const segments = this.speechSchedule;
    if (!segments.length) return 'closed';
    if (time <= segments[0].start) return segments[0].shape;
    const last = segments[segments.length - 1];
    if (time >= last.end) return 'closed';
    for (let i = 0; i < segments.length; i++) {
      if (time >= segments[i].start && time < segments[i].end) return segments[i].shape;
    }
    return 'closed';
  }

  setState(s) {
    this.state = s;
    this.speaking = s === 'SPEAKING';
    this.speechSchedule = [];
    // Don't switch to speaking video here; defer until audio actually starts (onStart)
    // to keep video and audio in sync. Switch back to standby on non-speaking states.
    if (s !== 'SPEAKING') {
      this.setActiveVideo('standby');
      this.targetMouthShape = 'closed';
      this.lastAppliedAt = performance.now();
    }
  }

  setActiveVideo(key) {
    if (!this.textures || !this.textures[key]) return;
    if (this.activeVideoKey === key) {
      const v = this.videos[key];
      if (v && v.paused) { v.currentTime = 0; v.play().catch(() => {}); }
      return;
    }
    const oldTexture = this.videoTexture;
    const oldKey = this.activeVideoKey;
    this.activeVideoKey = key;
    this.video = this.videos[key];
    this.videoTexture = this.textures[key];
    if (this.characterMesh && this.characterMesh.material) {
      this.characterMesh.material.map = this.videoTexture;
      this.characterMesh.material.needsUpdate = true;
    }
    // Crossfade: keep old video on overlay for 2s
    if (this.characterOverlay && oldTexture) {
      if (this.characterOverlay.material.uniforms) {
        this.characterOverlay.material.uniforms.map.value = oldTexture;
        this.characterOverlay.material.uniforms.map.value.needsUpdate = true;
      }
      this.characterOverlay.material.opacity = 1;
      this.characterOverlay.material.needsUpdate = true;
      this.characterOverlay.visible = true;
      this.transitionStart = performance.now();
      this.transitionDuration = 2000;
      this.transitioning = true;
    }
    for (const [k, v] of Object.entries(this.videos)) {
      if (k === key) { try { v.currentTime = 0; } catch (e) {} v.play().catch(() => {}); }
      else { v.pause(); }
    }
  }

  requestMouthShape(shape, force = false) {
    // Character is a video; mouth shapes are baked in. Keep API for compatibility.
    this.targetMouthShape = 'closed';
  }

  tickMouthShape(now) {}

  beginMouthBlend(fromShape, toShape) {}

  applyMouthTexture(shape) {}

  setMouthShape(shape) {}

  updateMouthBlend(_frameDelta) {}

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.renderer.setSize(rect.width, rect.height, false);
    const viewHeight = 2.45;
    const viewWidth = viewHeight * rect.width / rect.height;
    this.camera.left = -viewWidth / 2;
    this.camera.right = viewWidth / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    const imageWidth = 3.55;
    const aspect = this.characterAspect || 9 / 16;
    const imageHeight = imageWidth * aspect;
    const fit = Math.min(viewWidth / imageWidth, viewHeight / imageHeight) * 0.72;
    this.character.scale.setScalar(fit);
    this.updateBackgroundLayout();
    this.camera.updateProjectionMatrix();
  }

  animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const frameDelta = Math.min((now - this.previousFrameTime) / 1000, 0.05);
    this.previousFrameTime = now;

    if (this.character) {
      const clock = getSpeechClock();
      // no-op mouth animation; video loops on its own
    }
    if (this.videoTexture) this.videoTexture.needsUpdate = true;
    if (this.transitioning && this.characterOverlay) {
      const elapsed = performance.now() - this.transitionStart;
      const progress = Math.min(1, elapsed / this.transitionDuration);
      this.characterOverlay.material.opacity = 1 - progress;
      this.characterOverlay.material.needsUpdate = true;
      if (progress >= 1) {
        this.transitioning = false;
        this.characterOverlay.visible = false;
        this.characterOverlay.material.opacity = 0;
      }
      if (this.characterOverlay.material.uniforms && this.characterOverlay.material.uniforms.map.value) {
        this.characterOverlay.material.uniforms.map.value.needsUpdate = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.running = false;
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onCharacterPointerDown);
    this.canvas.removeEventListener('pointermove', this.onCharacterPointerMove);
    this.canvas.removeEventListener('pointerup', this.onCharacterPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onCharacterPointerUp);
    if (this.characterMesh) this.characterMesh.geometry.dispose();
    if (this.characterOverlay) this.characterOverlay.geometry.dispose();
    if (this.character) this.character.traverse((object) => {
      if (object.isMesh) object.geometry.dispose();
    });
    if (this.videoTexture) this.videoTexture.dispose();
    if (this.textures) for (const t of Object.values(this.textures)) t.dispose();
    if (this.videos) for (const v of Object.values(this.videos)) { v.pause(); v.removeAttribute('src'); v.load(); }
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    if (this.backgroundTexture) this.backgroundTexture.dispose();
    for (const material of this.materials) material.dispose();
    if (this.backgroundMesh) this.backgroundMesh.geometry.dispose();
    this.renderer.dispose();
  }
}
export default HologramScene;
