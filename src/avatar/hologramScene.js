import * as THREE from 'three';

const CHARACTER_ASSET_PATH = '/karakter_baru';
const CHARACTER_FRAME = { width: 512, height: 306 };

export class HologramScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'IDLE';
    this.speaking = false;
    this.speechSchedule = [];
    this.scheduleStartedAt = 0;
    this.currentMouthShape = 'closed';

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.2, -1.2, 0.1, 100);
    this.camera.position.set(0, 0, 5);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));

    this.character = this.createIllustration();
    this.scene.add(this.character);

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);

    this.running = true;
    this.animate();
  }

  createIllustration() {
    const root = new THREE.Group();
    root.name = 'Karakter Baru PUPR';
    this.textureLoader = new THREE.TextureLoader();
    this.poseTextures = {};
    this.materials = [];

    const imageWidth = 3.55;
    const imageHeight = imageWidth * CHARACTER_FRAME.height / CHARACTER_FRAME.width;
    const imageMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    this.materials.push(imageMaterial);
    this.characterMesh = new THREE.Mesh(new THREE.PlaneGeometry(imageWidth, imageHeight), imageMaterial);
    this.characterMesh.name = 'Foto karakter';
    root.add(this.characterMesh);
    this.enableCharacterDragging(root, this.characterMesh, imageWidth, imageHeight);

    const poseFiles = {
      closed: '02_closed.png',
      slight: '03_slightly_open.png',
      a: '04_open_A.png',
      ei: '05_spread_E_I.png',
      o: '06_rounded_O.png',
      u: '07_rounded_U.png',
      teeth: '08_teeth_lip.png',
      tongue: '09_tongue_teeth.png'
    };
    for (const [shape, filename] of Object.entries(poseFiles)) {
      this.textureLoader.load(`${CHARACTER_ASSET_PATH}/${filename}`, (sourceTexture) => {
        const texture = this.createPoseTexture(sourceTexture.image);
        sourceTexture.dispose();
        this.poseTextures[shape] = texture;
        if (shape === this.currentMouthShape) {
          imageMaterial.map = texture;
          imageMaterial.needsUpdate = true;
        }
      }, undefined, () => {
        // Tetap gunakan pose lain yang sudah berhasil dimuat.
      });
    }
    return root;
  }

  createPoseTexture(sourceImage) {
    const frame = document.createElement('canvas');
    frame.width = CHARACTER_FRAME.width;
    frame.height = CHARACTER_FRAME.height;
    const context = frame.getContext('2d');
    // Use one top-aligned full-photo crop for every pose; only excess lower image area is removed.
    context.drawImage(sourceImage, 0, 0, frame.width, frame.height, 0, 0, frame.width, frame.height);

    const texture = new THREE.CanvasTexture(frame);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  enableCharacterDragging(root, characterMesh, imageWidth, imageHeight) {
    const storageKey = 'pupr-avatar-character-position-v3';
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

  makeMouthSchedule(text, duration) {
    const vowelShapes = { a: 'a', e: 'ei', i: 'ei', o: 'o', u: 'u' };
    const segments = [];
    for (const char of text.toLowerCase()) {
      if (char.trim() === '') {
        segments.push({ shape: 'closed', weight: 0.035 });
      } else if (/[.,!?;:]/.test(char)) {
        segments.push({ shape: 'closed', weight: 0.09 });
      } else {
        const shape = vowelShapes[char] || (/[fv]/.test(char) ? 'teeth' : (/[bmp]/.test(char) ? 'closed' : (/[dtnl]/.test(char) ? 'tongue' : 'slight')));
        segments.push({ shape, weight: vowelShapes[char] ? 0.12 : 0.065 });
      }
    }
    const totalWeight = segments.reduce((sum, segment) => sum + segment.weight, 0) || 1;
    let time = 0;
    return segments.map((segment) => {
      const start = time;
      const segmentDuration = duration * segment.weight / totalWeight;
      time += segmentDuration;
      return { ...segment, start, end: time };
    });
  }

  setSpeechText(text, duration) {
    this.speechSchedule = this.makeMouthSchedule(text, duration);
    this.scheduleStartedAt = performance.now();
  }

  setSpeechWord(word, duration) {
    if (!this.speaking) return;
    this.speechSchedule = this.makeMouthSchedule(word, duration);
    this.scheduleStartedAt = performance.now();
  }

  setState(s) {
    this.state = s;
    this.speaking = s === 'SPEAKING';
    this.speechSchedule = [];
    if (s !== 'SPEAKING') this.setMouthShape('closed');
  }

  setMouthShape(shape) {
    const texture = this.poseTextures[shape] || this.poseTextures.closed;
    this.currentMouthShape = shape;
    if (texture && this.characterMesh.material.map !== texture) {
      this.characterMesh.material.map = texture;
      this.characterMesh.material.needsUpdate = true;
    }
  }

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
    const imageHeight = imageWidth * CHARACTER_FRAME.height / CHARACTER_FRAME.width;
    const fit = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
    this.character.scale.setScalar(fit);
    this.camera.updateProjectionMatrix();
  }

  animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    if (this.character) {
      const elapsed = (now - this.scheduleStartedAt) / 1000;
      const segment = this.speaking
        ? this.speechSchedule.find((item) => elapsed >= item.start && elapsed < item.end)
        : null;
      this.setMouthShape(segment ? segment.shape : 'closed');
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
    this.characterMesh.geometry.dispose();
    this.character.traverse((object) => {
      if (object.isMesh) object.geometry.dispose();
    });
    for (const texture of Object.values(this.poseTextures)) texture.dispose();
    for (const material of this.materials) material.dispose();
    this.renderer.dispose();
  }
}
export default HologramScene;