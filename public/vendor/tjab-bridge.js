/* TJAB in-page bridge — Three.js Agent Bridge SDK.
 * UMD: works as classic <script>, ESM import, or injected via Playwright addInitScript.
 * Zero runtime dependencies; three.js is a peer (obtained via attach opts or global hook).
 * Exposes window.__THREE_AGENT__ (singleton dispatcher) and window.TJAB (API).
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(global);
  else if (typeof define === 'function' && define.amd) define([], function () { return factory(global); });
  else global.TJAB = factory(global);
})(typeof self !== 'undefined' ? self : globalThis, function (global) {
  'use strict';

  /* ============================= helpers ============================= */
  function err(code, message, data) { const e = new Error(message); e.code = code; if (data !== undefined) e.data = data; return e; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return h >>> 0; }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function deepClone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
  }
  const fmt = (n) => { n = +n; return isFinite(n) ? +n.toFixed(6) : n; };
  const v3 = (v) => ({ x: fmt(v.x), y: fmt(v.y), z: fmt(v.z) });

  /* ============================= state ============================= */
  const state = {
    version: '0.1.0',
    renderer: null, scene: null, camera: null,
    source: 'none',                 // 'sdk' | 'auto' | 'none'
    attached: false,
    viewportId: 'main',
    // loop
    controlled: false, paused: false, timeScale: 1, nominalDt: 16.67,
    clock: 0, frameIndex: 0, lastDt: 16.67, frameTimes: [],
    // appLoop, loopFn: the app's frame callback. loopFn = callback captured from
    // the rAF queue at takeControl (covers three r16x+ where the loop lives in
    // constructor closures and renderer._animationLoop does not exist).
    appLoop: null, loopFn: null, origSetAnimationLoop: null,
    // rAF
    rafQueue: [], rafIds: new Map(), rafSeq: 0, rafScheduled: false,
    origRaf: null, origCancelRaf: null,
    // rng
    seedValue: null, seededRand: null, tjRand: Math.random,
    // ring
    ring: { frames: [], maxFrames: 300, maxEvents: 10000, events: [], lastCap: 0, capEvery: 5, capTick: 0, hashSeq: [] },
    // capture cache
    capRTs: {},
    // policies
    policies: [],
    // recordings
    recordings: [], rec: null, replay: null,
    // snapshots for scene.diff
    snap: null,
    // telemetry
    fetchCount: 0, wsCount: 0, fetchOrig: null, wsOrig: null,
    // streams
    streams: {}, streamSeq: 0,
    // three ref (may arrive late)
    THREE: null,
    // audio tap
    audio: null,
    // gamepad spoof
    gamepad: null,
    // waiters
    waiters: [],
  };

  /* ============================= three access ============================= */
  function three() {
    if (state.THREE) return state.THREE;
    if (global.__TJAB_THREE__) { state.THREE = global.__TJAB_THREE__; return state.THREE; }
    return null;
  }

  /* ============================= object lookup ============================= */
  function findObj(idOrName) {
    if (!state.scene) return null;
    if (typeof idOrName !== 'string') return null;
    let o = state.scene.getObjectByProperty('uuid', idOrName);
    if (!o) o = state.scene.getObjectByName(idOrName);
    return o || null;
  }
  function effectiveVisible(o) {
    let v = o.visible, p = o.parent;
    while (v && p) { v = p.visible; p = p.parent; }
    return v;
  }
  function isMeshLike(o) { return o && o.isMesh; }

  /* world bounds (Box3) with memo per object+matrix version */
  const boundsCache = new WeakMap();
  function worldBounds(o) {
    const mv = o.matrixWorld;
    const ver = mv && (mv.elements[0] + mv.elements[5] + mv.elements[10] + mv.elements[12] + mv.elements[13] + mv.elements[14]);
    const c = boundsCache.get(o);
    if (c && c.ver === ver) return c.box;
    if (!o.geometry) { const b = new (three().Box3)(); b.setFromObject(o); const box = b; boundsCache.set(o, { ver, box }); return box; }
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    boundsCache.set(o, { ver, box });
    return box;
  }
  function boundsCenter(o) {
    if (o.geometry) { const b = worldBounds(o); return b.getCenter(new (three().Vector3)()); }
    return o.position.clone();
  }

  /* ============================= scene serialization ============================= */
  function nodeInfo(o, depth, maxDepth) {
    const T = three();
    const n = {
      id: o.uuid, name: o.name || '', type: o.type || o.constructor.name,
      visible: effectiveVisible(o),
      transform: {
        pos: [fmt(o.position.x), fmt(o.position.y), fmt(o.position.z)],
        rot: [fmt(o.rotation.x), fmt(o.rotation.y), fmt(o.rotation.z)],
        scale: [fmt(o.scale.x), fmt(o.scale.y), fmt(o.scale.z)],
      },
    };
    if (isMeshLike(o)) {
      const b = worldBounds(o);
      n.bounds = { min: [fmt(b.min.x), fmt(b.min.y), fmt(b.min.z)], max: [fmt(b.max.x), fmt(b.max.y), fmt(b.max.z)] };
      n.mesh = { vertices: o.geometry.attributes.position ? o.geometry.attributes.position.count : 0, triangles: o.geometry.index ? o.geometry.index.count / 3 : (o.geometry.attributes.position ? o.geometry.attributes.position.count / 3 : 0) };
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        n.mesh.material = m.name || m.type;
        if (m.color) n.mesh.materialColor = '#' + m.color.getHexString();
      }
    } else if (o.isLight) {
      n.light = { kind: o.type, intensity: o.intensity, color: o.color ? '#' + o.color.getHexString() : null };
    }
    if (o.children && o.children.length && depth < (maxDepth == null ? 10 : maxDepth)) {
      n.children = o.children.map((c) => nodeInfo(c, depth + 1, maxDepth));
    }
    return n;
  }
  function sceneGraph(depth) {
    return nodeInfo(state.scene, 0, depth == null ? 10 : depth);
  }
  function sceneFind(q) {
    const out = [];
    state.scene.traverse((o) => {
      if (o === state.scene) return;
      if (q.type && (o.type !== q.type && o.constructor.name !== q.type)) return;
      if (q.name && o.name !== q.name) return;
      if (q.visible !== undefined && effectiveVisible(o) !== !!q.visible) return;
      if (q.hasMaterial && !o.material) return;
      out.push({ id: o.uuid, name: o.name || '', type: o.type || o.constructor.name });
    });
    return out;
  }
  function objDigest(o) {
    const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
    return hashStr([o.uuid, o.position.x.toFixed(4), o.position.y.toFixed(4), o.position.z.toFixed(4),
      o.rotation.x.toFixed(4), o.rotation.y.toFixed(4), o.rotation.z.toFixed(4),
      o.scale.x.toFixed(4), o.scale.y.toFixed(4), o.scale.z.toFixed(4),
      o.visible ? 1 : 0, m && m.color ? m.color.getHexString() : ''].join('|'));
  }
  function snapshotNow() {
    const map = {};
    state.scene.traverse((o) => { if (o !== state.scene) map[o.uuid] = objDigest(o); });
    return map;
  }
  function sceneDiff(sinceId) {
    const prev = state.snap || snapshotNow();
    const cur = snapshotNow();
    state.snap = cur;
    const added = [], removed = [], changed = [];
    for (const id of Object.keys(cur)) if (!(id in prev)) added.push(id);
    for (const id of Object.keys(prev)) if (!(id in cur)) removed.push(id);
    for (const id of Object.keys(prev)) if (id in cur && prev[id] !== cur[id]) changed.push(id);
    return { added, removed, changed };
  }

  /* ============================= object prop packs ============================= */
  function materialInfo(o) {
    const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
    if (!m) return null;
    const T = three();
    const info = { name: m.name || '', type: m.type, transparent: !!m.transparent, opacity: m.opacity, depthWrite: !!m.depthWrite, depthTest: !!m.depthTest, wireframe: !!m.wireframe };
    if (m.color) info.color = '#' + m.color.getHexString();
    if (m.map) info.map = m.map.image && m.map.image.currentSrc ? m.map.image.currentSrc : (m.map.name || null);
    if (m.emissive && m.emissive.getHex) info.emissive = '#' + m.emissive.getHexString();
    if (m.metalness !== undefined) info.metalness = m.metalness;
    if (m.roughness !== undefined) info.roughness = m.roughness;
    if (o.isLight) info.intensity = o.intensity;
    return info;
  }
  function objectInfo(id, props) {
    const o = findObj(id);
    if (!o) throw err('OBJECT_GONE', 'object not found: ' + id, { suggestion: 'use scene.find to discover current ids' });
    const T = three();
    const full = {
      id: o.uuid, name: o.name || '', type: o.type || o.constructor.name, visible: effectiveVisible(o),
      position: v3(o.position), rotation: v3(o.rotation), scale: v3(o.scale),
      quaternion: [fmt(o.quaternion.x), fmt(o.quaternion.y), fmt(o.quaternion.z), fmt(o.quaternion.w)],
      parent: o.parent ? o.parent.uuid : null,
      children: o.children.map((c) => c.uuid),
      worldPosition: v3(o.getWorldPosition(new (three().Vector3)())),
    };
    if (isMeshLike(o)) {
      full.bounds = (() => { const b = worldBounds(o); return { min: [fmt(b.min.x), fmt(b.min.y), fmt(b.min.z)], max: [fmt(b.max.x), fmt(b.max.y), fmt(b.max.z)] }; })();
      full.material = materialInfo(o);
      full.mesh = { vertices: o.geometry.attributes.position ? o.geometry.attributes.position.count : 0, triangles: o.geometry.index ? o.geometry.index.count / 3 : 0 };
    } else if (o.isLight) full.light = { kind: o.type, intensity: o.intensity, color: o.color ? '#' + o.color.getHexString() : null };
    else if (o.isCamera) full.camera = { fov: o.fov, near: o.near, far: o.far };
    if (props && Array.isArray(props)) {
      const out = {};
      for (const p of props) if (p in full) out[p] = full[p];
      return out;
    }
    return full;
  }

  /* ============================= object mutation ============================= */
  const SET_KEYS = ['position', 'rotation', 'scale', 'quaternion', 'visible', 'name', 'material.color', 'material.map', 'material.opacity', 'castShadow', 'receiveShadow', 'intensity'];
  function applySet(o, patch) {
    const T = three();
    for (const k of Object.keys(patch)) {
      if (!SET_KEYS.includes(k)) throw err('INVALID_PARAMS', 'unknown object.set key: ' + k, { known: SET_KEYS });
    }
    if (patch.position !== undefined) { const v = patch.position; if (Array.isArray(v)) o.position.set(v[0], v[1], v[2]); else o.position.set(v.x, v.y, v.z); }
    if (patch.rotation !== undefined) { const v = patch.rotation; if (Array.isArray(v)) o.rotation.set(v[0], v[1], v[2]); else o.rotation.set(v.x, v.y, v.z); }
    if (patch.scale !== undefined) { const v = patch.scale; if (Array.isArray(v)) o.scale.set(v[0], v[1], v[2]); else o.scale.set(v.x, v.y, v.z); }
    if (patch.quaternion !== undefined) { const v = patch.quaternion; o.quaternion.set(v[0], v[1], v[2], v[3]); }
    if (patch.visible !== undefined) o.visible = !!patch.visible;
    if (patch.name !== undefined) o.name = String(patch.name);
    if (patch.castShadow !== undefined) o.castShadow = !!patch.castShadow;
    if (patch.receiveShadow !== undefined) o.receiveShadow = !!patch.receiveShadow;
    if (patch.intensity !== undefined && o.isLight) o.intensity = patch.intensity;
    if (patch['material.color'] !== undefined && o.material) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const c = patch['material.color'];
      if (typeof c === 'string') m.color.set(c);
      else if (typeof c === 'number') m.color.setHex(c);
      else m.color.setRGB(c.r, c.g, c.b);
      m.needsUpdate = true;
    }
    if (patch['material.opacity'] !== undefined && o.material) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      m.opacity = clamp(patch['material.opacity'], 0, 1); m.transparent = m.opacity < 1; m.needsUpdate = true;
    }
    if (patch['material.map'] !== undefined && o.material) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!T) throw err('CODE_DISABLED', 'THREE not available for texture loading');
      const url = patch['material.map'];
      if (url === null || url === '') { m.map = null; m.needsUpdate = true; }
      else {
        const loader = new T.TextureLoader();
        return new Promise((res, rej) => {
          loader.load(url, (tex) => {
            if (T.SRGBColorSpace !== undefined) tex.colorSpace = T.SRGBColorSpace;
            m.map = tex; m.needsUpdate = true; res();
          }, undefined, (e) => rej(err('INVALID_PARAMS', 'texture load failed: ' + url, { detail: String(e) })));
        });
      }
    }
    o.updateMatrixWorld(true);
    return Promise.resolve();
  }
  async function objectSet(id, patch) {
    const o = findObj(id);
    if (!o) throw err('OBJECT_GONE', 'object not found: ' + id);
    await applySet(o, patch);
    return objectInfo(id);
  }

  const PRIMITIVES = {
    box: ['BoxGeometry', (T, g) => new T.MeshStandardMaterial({ color: 0xff8844, roughness: 0.7 })],
    sphere: ['SphereGeometry', (T, g) => new T.MeshStandardMaterial({ color: 0x44ccff, roughness: 0.4 })],
    plane: ['PlaneGeometry', (T, g) => new T.MeshStandardMaterial({ color: 0x88aa66, side: T.DoubleSide })],
  };
  function hasLights() {
    let f = false;
    state.scene.traverse((o) => { if (o.isLight) f = true; });
    return f;
  }
  async function objectAdd(params) {
    const T = three();
    if (!T) throw err('CODE_DISABLED', 'THREE not available');
    let obj = null;
    if (params.gltfUrl) {
      throw err('CODE_DISABLED', 'GLTF loading requires app-side loader; use eval.js to add GLTF', { hint: 'object.add supports primitives: box/sphere/plane/light' });
    }
    if (params.primitive) {
      const p = params.primitive.toLowerCase();
      if (p === 'light') {
        obj = new T.DirectionalLight(0xffffff, params.intensity || 1);
        obj.position.set(params.transform && params.transform.position ? params.transform.position[0] : 0,
          params.transform && params.transform.position ? params.transform.position[1] : 10,
          params.transform && params.transform.position ? params.transform.position[2] : 0);
      } else if (PRIMITIVES[p]) {
        const [geoFn, matFn] = PRIMITIVES[p];
        const geo = new T[geoFn]();
        const mat = matFn(T);
        if (!hasLights() && mat.isMeshStandardMaterial) mat.color.setHex(0x999999);
        obj = new T.Mesh(geo, mat);
        obj.name = params.name || ('tjab-' + p + '-' + Math.floor(Math.random() * 1e6));
      } else {
        throw err('INVALID_PARAMS', 'unknown primitive: ' + p, { known: ['box', 'sphere', 'plane', 'light'] });
      }
      if (params.transform) {
        if (params.transform.position) obj.position.set(...params.transform.position);
        if (params.transform.rotation) obj.rotation.set(...params.transform.rotation);
        if (params.transform.scale) obj.scale.set(...params.transform.scale);
      }
      const parent = params.parent ? findObj(params.parent) : state.scene;
      if (!parent) throw err('OBJECT_GONE', 'parent not found: ' + params.parent);
      parent.add(obj);
    } else {
      throw err('INVALID_PARAMS', 'object.add requires primitive or gltfUrl');
    }
    return { id: obj.uuid, name: obj.name || '', type: obj.type };
  }
  function objectRemove(id) {
    const o = findObj(id);
    if (!o) throw err('OBJECT_GONE', 'object not found: ' + id);
    if (o.parent) o.parent.remove(o);
    return { removed: true, id };
  }
  function objectFocus(id) {
    const T = three();
    if (!state.camera) throw err('BRIDGE_NOT_FOUND', 'no camera attached');
    const target = id === 'scene' || id == null ? state.scene : findObj(id);
    if (!target) throw err('OBJECT_GONE', 'object not found: ' + id);
    const b = target.geometry ? worldBounds(target) : null;
    const center = b ? b.getCenter(new T.Vector3()) : target.position.clone();
    const dir = state.camera.getWorldDirection(new T.Vector3());
    const radius = b ? b.getSize(new T.Vector3()).length() / 2 : 1;
    state.camera.position.copy(center).addScaledVector(dir, radius * 2.5);
    state.camera.lookAt(center);
    if (state.camera.updateProjectionMatrix) state.camera.updateProjectionMatrix();
    return { focused: id, position: v3(state.camera.position) };
  }

  /* ============================= camera ============================= */
  function cameraSet(p) {
    const T = three();
    if (!state.camera) throw err('BRIDGE_NOT_FOUND', 'no camera attached');
    if (p.projection && p.projection !== 'perspective') throw err('CODE_DISABLED', 'projection swap not supported in v1; perspective only', { decision: 'docs/decisions.md #3' });
    if (p.position) {
      if (Array.isArray(p.position)) state.camera.position.set(p.position[0], p.position[1], p.position[2]);
      else state.camera.position.set(p.position.x, p.position.y, p.position.z);
    }
    if (p.target) {
      if (Array.isArray(p.target)) state.camera.lookAt(p.target[0], p.target[1], p.target[2]);
      else state.camera.lookAt(p.target.x, p.target.y, p.target.z);
    }
    if (p.fov && state.camera.isPerspectiveCamera) state.camera.fov = p.fov;
    if (state.camera.updateProjectionMatrix) state.camera.updateProjectionMatrix();
    return { position: v3(state.camera.position), fov: state.camera.fov, frameIndex: state.frameIndex };
  }
  function cameraFit(id) {
    return objectFocus(id === 'scene' ? 'scene' : id);
  }

  /* ============================= capture core ============================= */
  function getCaptureRT(w, h) {
    const T = three();
    const key = w + 'x' + h;
    let rt = state.capRTs[key];
    if (!rt) {
      // WebGLRenderTarget construction consumes Math.random for uuids — keep
      // every size cached so captures never touch the (possibly seeded) stream
      rt = new T.WebGLRenderTarget(w, h, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, format: T.RGBAFormat, type: T.UnsignedByteType });
      state.capRTs[key] = rt;
    }
    return rt;
  }
  function canvasSize() {
    const c = state.renderer.domElement;
    return { w: c.width || 800, h: c.height || 600 };
  }
  function readRT(rt, w, h) {
    const buf = new Uint8Array(w * h * 4);
    state.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return buf;
  }
  function bufToCanvas(buf, w, h, mime, quality) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(buf);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL(mime || 'image/png', quality == null ? 0.8 : quality);
  }
  function flipV(buf, w, h) {
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let y = 0; y < h / 2; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(buf.subarray(a, a + row));
      buf.copyWithin(a, b, b + row);
      buf.set(tmp, b);
    }
    return buf;
  }
  /* visible meshes (skips Points/Lines; skips non-meshables) */
  function visibleMeshes() {
    const out = [];
    state.scene.traverse((o) => { if (isMeshLike(o) && effectiveVisible(o)) out.push(o); });
    return out;
  }
  function renderToRT(rt, w, h, materialSwap) {
    const r = state.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const swapped = [];
    try {
      r.setRenderTarget(rt);
      r.autoClear = true;
      if (materialSwap) {
        const meshes = visibleMeshes();
        for (let i = 0; i < meshes.length; i++) {
          const o = meshes[i];
          swapped.push({ o, orig: o.material });
          o.material = materialSwap(o, i);
        }
      }
      r.render(state.scene, state.camera);
    } finally {
      for (const s of swapped) s.o.material = s.orig; // atomic restore, even on error
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
    }
  }
  function makeCapture(rt, w, h, mime, quality) {
    const buf = flipV(readRT(rt, w, h), w, h);
    const data = bufToCanvas(buf, w, h, mime, quality);
    return { data, mimeType: mime || 'image/png', width: w, height: h, frameIndex: state.frameIndex, viewportId: state.viewportId };
  }
  function idMaterial(index) {
    const T = three();
    const r = (index >> 16) & 255, g = (index >> 8) & 255, b = index & 255;
    return new T.ShaderMaterial({
      uniforms: { uIdx: { value: new T.Vector3(r / 255, g / 255, b / 255) } },
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uIdx; void main(){ gl_FragColor = vec4(uIdx, 1.0); }',
      depthTest: true, depthWrite: true,
    });
  }
  function depthMaterial(near, far) {
    const T = three();
    return new T.ShaderMaterial({
      uniforms: { uNear: { value: near }, uFar: { value: far } },
      vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uNear; uniform float uFar; varying float vD; void main(){ float d = clamp((uFar - vD) / (uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(d, d, d, 1.0); }',
      depthTest: true, depthWrite: true,
    });
  }
  function warmupCaptureRTs() {
    try {
      const { w, h } = canvasSize();
      getCaptureRT(w, h);
      getCaptureRT(Math.min(w, 240), Math.max(1, Math.round(240 * h / w)));
      getCaptureRT(Math.min(w, 320), Math.max(1, Math.round(320 * h / w)));
    } catch (e) { /* renderer not ready; RTs get created lazily */ }
  }
  function captureRGB(params) {
    if (!state.renderer || !state.scene || !state.camera) throw err('BRIDGE_NOT_FOUND', 'bridge not attached to a renderer/scene/camera');
    const { w, h } = canvasSize();
    const width = Math.min(params.width || w, 1920);
    const height = params.height ? Math.min(params.height, 1920) : Math.round(width * h / w);
    const rt = getCaptureRT(width, height);
    renderToRT(rt, width, height, null);
    return makeCapture(rt, width, height, params.format === 'jpeg' ? 'image/jpeg' : 'image/png', params.quality);
  }
  function captureID(params) {
    const { w, h } = canvasSize();
    const width = Math.min(params.width || w, 1920);
    const height = params.height ? Math.min(params.height, 1920) : Math.round(width * h / w);
    const meshes = visibleMeshes();
    const idIndex = {};
    meshes.forEach((o, i) => { idIndex[String(i + 1)] = { id: o.uuid, name: o.name || '', type: o.type }; });
    const rt = getCaptureRT(width, height);
    renderToRT(rt, width, height, (o, i) => idMaterial(i + 1));
    const cap = makeCapture(rt, width, height, 'image/png', 1);
    cap.idIndex = idIndex;
    return cap;
  }
  function captureDepth(params) {
    if (!state.camera) throw err('BRIDGE_NOT_FOUND', 'no camera attached');
    const near = state.camera.near || 0.1, far = state.camera.far || 1000;
    const { w, h } = canvasSize();
    const width = Math.min(params.width || w, 1920);
    const height = params.height ? Math.min(params.height, 1920) : Math.round(width * h / w);
    const rt = getCaptureRT(width, height);
    const mat = depthMaterial(near, far);
    renderToRT(rt, width, height, () => mat);
    return makeCapture(rt, width, height, 'image/png', 1);
  }

  /* ============================= projection (symbolic click) ============================= */
  function worldToScreen(o) {
    const T = three();
    const c = state.renderer.domElement;
    const rect = c.getBoundingClientRect();
    const center = boundsCenter(o);
    const ndc = center.clone().project(state.camera);
    const x = rect.left + (ndc.x * 0.5 + 0.5) * rect.width;
    const y = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height;
    const offscreen = ndc.z < -1 || ndc.z > 1 || x < rect.left - 1 || x > rect.right + 1 || y < rect.top - 1 || y > rect.bottom + 1;
    return { x, y, ndc: [ndc.x, ndc.y, ndc.z], offscreen };
  }
  function raycastScreen(clientX, clientY) {
    const T = three();
    const c = state.renderer.domElement;
    const rect = c.getBoundingClientRect();
    const ndc = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new T.Raycaster();
    raycaster.setFromCamera(ndc, state.camera);
    const hits = raycaster.intersectObjects(visibleMeshes(), false);
    return hits.map((h) => ({ id: h.object.uuid, name: h.object.name || '', type: h.object.type, distance: h.distance, point: [fmt(h.point.x), fmt(h.point.y), fmt(h.point.z)] }));
  }
  function projectClick(id, forceRaycast) {
    const o = findObj(id);
    if (!o) throw err('OBJECT_GONE', 'object not found: ' + id);
    const { x, y, offscreen } = worldToScreen(o);
    if (offscreen) return { clicked: false, reason: 'offscreen', x, y, frameIndex: state.frameIndex };
    const hits = raycastScreen(x, y);
    const hit = hits[0];
    if (!hit) return { clicked: false, reason: 'no-hit', x, y, frameIndex: state.frameIndex };
    const targetUuid = o.uuid;
    let ok = hit.id === targetUuid;
    if (!ok) {
      // target is an ancestor of the hit object?
      let p = findObj(hit.id);
      while (p && p.parent) { p = p.parent; if (p.uuid === targetUuid) { ok = true; break; } }
    }
    if (!ok && !forceRaycast) return { clicked: false, reason: 'occluded', occluder: hit.name || hit.id, x, y, frameIndex: state.frameIndex };
    return { clicked: true, x, y, hit: hit.id === targetUuid ? null : hit, frameIndex: state.frameIndex };
  }

  /* ============================= loop machinery ============================= */
  function installRafWrap() {
    if (state.origRaf) return;
    state.origRaf = global.requestAnimationFrame.bind(global);
    state.origCancelRaf = global.cancelAnimationFrame.bind(global);
    global.requestAnimationFrame = (cb) => {
      const id = ++state.rafSeq;
      state.rafIds.set(id, cb);
      if (!state.rafScheduled) {
        state.rafScheduled = true;
        state.origRaf((t) => {
          state.rafScheduled = false;
          const batch = [];
          state.rafIds.forEach((cb2, id2) => { batch.push([id2, cb2]); });
          state.rafIds.clear();
          if (state.controlled) {
            // bridge drives the loop: raw-rAF apps queue for step(); apps whose
            // loop was captured (loopFn) or registered via setAnimationLoop
            // (appLoop) are driven directly, so stray re-requests are swallowed.
            if (!state.loopFn && !state.appLoop) state.rafQueue.push(...batch);
            return;
          }
          if (state.paused) { state.rafQueue.push(...batch); return; }
          const now = global.performance.now();
          for (const [, cb2] of batch) { try { cb2(now); } catch (e) { logEvent('error', { source: 'raf', message: String(e && e.message || e) }); } }
          afterFrame();
        });
      }
      return id;
    };
    global.cancelAnimationFrame = (id) => { state.rafIds.delete(id); };
  }
  function runQueuedRaf() {
    const batch = state.rafQueue.splice(0);
    const t = state.clock;
    for (const [, cb] of batch) { try { cb(t); } catch (e) { logEvent('error', { source: 'raf', message: String(e && e.message || e) }); } }
    return batch.length;
  }
  /* after a real (passive) frame: count, policies, ring, hashes, record keyframes */
  function afterFrame() {
    state.frameIndex++;
    state.clock += state.lastDt;
    recordFrameTime(state.lastDt);
    runPolicies('frame');
    ringCaptureIfDue();
    computeHash();
    recordTick();
  }
  function recordFrameTime(dt) {
    state.frameTimes.push(dt);
    if (state.frameTimes.length > 240) state.frameTimes.shift();
  }
  /* controlled frame: exactly one app frame with fixed dt */
  function runFrame(dt) {
    state.frameIndex++;
    state.lastDt = dt;
    state.clock += dt;
    if (state.replay) replayInject(state.frameIndex);
    if (state.appLoop) { try { state.appLoop(state.clock, state.frameIndex); } catch (e) { logEvent('error', { source: 'appLoop', message: String(e && e.message || e) }); } }
    else if (state.loopFn) { try { state.loopFn(state.clock, state.frameIndex); } catch (e) { logEvent('error', { source: 'loopFn', message: String(e && e.message || e) }); } }
    else runQueuedRaf();
    recordFrameTime(dt);
    runPolicies('frame');
    ringCaptureIfDue();
    computeHash();
    if (state.replay) replayDivergenceCheck(state.frameIndex); // compare AFTER this frame's hash exists
    recordTick();
    return state.frameIndex;
  }
  async function takeControl() {
    if (state.controlled) return { already: true };
    state.controlled = true;
    if (!state.loopFn && !state.appLoop) {
      // Wait for the next native tick so the app's pending loop callback
      // (three's onAnimationFrame, or the app's own rAF callback) lands in our
      // queue, then capture it. Without this, a tick that just fired leaves the
      // queue empty and the app never advances under step().
      await new Promise((res) => state.origRaf(res));
      if (state.rafQueue.length) { state.loopFn = state.rafQueue[0][1]; state.rafQueue.length = 0; }
      else if (state.rafIds.size) { for (const [, cb] of state.rafIds) { state.loopFn = cb; break; } }
    }
    state.rafIds.clear();
    state.rafQueue.length = 0;
    return { controlled: true, frameIndex: state.frameIndex, loopCaptured: !!state.loopFn, appLoopKnown: !!state.appLoop };
  }
  function step(params) {
    const frames = params.frames || 1;
    const dt = params.dt != null ? params.dt : state.nominalDt * state.timeScale;
    const hashes = params.collectHashes ? [] : null;
    for (let i = 0; i < frames; i++) {
      runFrame(dt);
      if (hashes) hashes.push(state.ring.hashSeq[state.ring.hashSeq.length - 1]);
    }
    return { frame: state.frameIndex, t: state.clock, hashes };
  }
  function seedRng(seed) {
    state.seedValue = seed >>> 0;
    state.seededRand = mulberry32(state.seedValue);
    state.tjRand = state.seededRand;
    global.Math.random = state.seededRand;
    return { seeded: true, rng: state.seedValue };
  }

  /* ============================= scene hash ============================= */
  function computeHash() {
    if (!state.scene) { state.ring.hashSeq.push(0); if (state.ring.hashSeq.length > 20000) state.ring.hashSeq.shift(); return 0; }
    let h = 2166136261 >>> 0;
    state.scene.traverse((o) => {
      if (!o.position || !effectiveVisible(o)) return; // visible state only
      h = (h ^ (o.position.x * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
      h = (h ^ (o.position.y * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
      h = (h ^ (o.position.z * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
      if (o.rotation) {
        h = (h ^ (o.rotation.x * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
        h = (h ^ (o.rotation.y * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
        h = (h ^ (o.rotation.z * 1000 | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0;
      }
    });
    h = h >>> 0;
    state.ring.hashSeq.push(h);
    if (state.ring.hashSeq.length > 20000) state.ring.hashSeq.shift();
    return h;
  }

  /* ============================= ring buffer ============================= */
  function ringCaptureIfDue() {
    const r = state.ring;
    if (r.maxFrames <= 0) return; // ring disabled — skip the capture work entirely
    r.capTick++;
    if (r.capTick % r.capEvery !== 0) return;
    const now = global.performance.now();
    if (now - r.lastCap < 66) return; // max ~15fps storage
    r.lastCap = now;
    let jpeg = null;
    try {
      const { w, h } = canvasSize();
      const width = Math.min(w, 240);
      const height = Math.round(width * h / w);
      const rt = getCaptureRT(width, height);
      renderToRT(rt, width, height, null);
      jpeg = makeCapture(rt, width, height, 'image/jpeg', 0.5).data;
    } catch (e) { jpeg = null; }
    const rec = { frameIndex: state.frameIndex, t: state.clock, jpeg, inputs: [], sceneHash: state.ring.hashSeq[state.ring.hashSeq.length - 1] || 0 };
    r.frames.push(rec);
    if (r.frames.length > r.maxFrames) r.frames.shift();
    // move current-frame events into the frame record
    if (r.events.length) {
      const evs = r.events.splice(0);
      for (const ev of evs) {
        const f = r.frames.find((fr) => fr.frameIndex === ev.frame);
        if (f) f.inputs.push(ev.payload);
      }
    }
  }
  function logEvent(type, payload) {
    const entry = { frame: state.frameIndex, t: state.clock, type, payload };
    state.ring.events.push(entry);
    if (state.ring.events.length > state.ring.maxEvents) state.ring.events.shift();
    if (state.rec) {
      state.rec.events.push(entry);
      if (type === 'input') {
        // per-frame input arrays (relative to recording start) for replay.
        // Events arrive between frames (single-threaded), so the app applies
        // them during the NEXT frame's update: index by frame+1 so replay
        // injection (which runs before the update of that frame) matches.
        const rel = entry.frame + 1 - state.rec.startFrame;
        while (state.rec.inputs.length <= rel) state.rec.inputs.push([]);
        if (payload.type === 'key') state.rec.inputs[rel].push({ type: 'key', code: payload.code, phase: payload.phase });
        else state.rec.inputs[rel].push({ type: 'click', x: payload.x, y: payload.y });
      }
    }
    return entry;
  }
  function installEventHooks() {
    if (state.eventHooks) return;
    state.eventHooks = true;
    const on = (type, fn) => global.addEventListener(type, fn, true);
    on('keydown', (e) => { logEvent('input', { type: 'key', code: e.code || e.key, phase: 'down' }); });
    on('keyup', (e) => { logEvent('input', { type: 'key', code: e.code || e.key, phase: 'up' }); });
    on('pointerdown', (e) => { logEvent('input', { type: 'pointer', button: e.button, phase: 'down', x: e.clientX, y: e.clientY }); });
    on('pointerup', (e) => { logEvent('input', { type: 'pointer', button: e.button, phase: 'up', x: e.clientX, y: e.clientY }); });
    on('click', (e) => { logEvent('input', { type: 'click', x: e.clientX, y: e.clientY }); });
    global.addEventListener('error', (e) => { logEvent('error', { message: String(e.message || e), source: e.filename || 'window' }); }, true);
    global.addEventListener('unhandledrejection', (e) => { logEvent('error', { message: String(e.reason && e.reason.message || e.reason), source: 'promise' }); }, true);
  }

  /* ============================= policies ============================= */
  function compilePolicy(p) {
    if (!p || !p.name || typeof p.code !== 'string') throw err('INVALID_PARAMS', 'policy requires name + code');
    if (p.code.length > 100 * 1024) throw err('INVALID_PARAMS', 'policy code exceeds 100KB');
    let fn;
    try { fn = new Function('state', 'api', p.code); } catch (e) { throw err('INVALID_PARAMS', 'policy code does not compile: ' + e.message); }
    let trigger = p.trigger;
    if (typeof trigger === 'string') trigger = { kind: trigger };
    else if (trigger && typeof trigger === 'object') {
      if (trigger.event) trigger = { kind: 'event', event: trigger.event };
      else if (trigger.condition) trigger = { kind: 'condition', condition: trigger.condition };
      else trigger = { kind: 'frame' };
    } else trigger = { kind: 'frame' };
    if (trigger.kind === 'condition') {
      let condFn;
      try { condFn = new Function('state', 'api', 'return (' + trigger.condition + ');'); } catch (e) { throw err('INVALID_PARAMS', 'policy condition does not compile: ' + e.message); }
      trigger.condFn = condFn;
    }
    return {
      name: p.name, code: p.code, fn, trigger, priority: p.priority || 0,
      enabled: p.enabled !== false, faults: 0, timeAcc: 0, timeN: 0, paused: false,
    };
  }
  function makePolicyState() {
    const T = three();
    return {
      player: (state.playerRef && findObj(state.playerRef)) || null,
      object: (idOrName) => {
        const o = findObj(idOrName);
        if (!o) return null;
        const info = objectInfo(o.uuid);
        return { id: info.id, name: info.name, position: info.position, worldPosition: info.worldPosition, bounds: info.bounds, visible: info.visible };
      },
      objects: (namePrefix) => {
        const out = [];
        state.scene.traverse((o) => { if (o !== state.scene && o.name && namePrefix && o.name.startsWith(namePrefix)) out.push(o.uuid); });
        return out;
      },
      raycast: (origin, dir, maxDist) => {
        if (!T) return [];
        const ray = new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...dir).normalize(), 0, maxDist || 100);
        const hits = ray.intersectObjects(visibleMeshes(), false);
        return hits.map((h) => ({ id: h.object.uuid, name: h.object.name || '', distance: h.distance, point: [fmt(h.point.x), fmt(h.point.y), fmt(h.point.z)] }));
      },
      time: { frame: state.frameIndex, t: state.clock, scale: state.timeScale, controlled: state.controlled },
    };
  }
  function makePolicyApi() {
    return {
      press: (code) => { dispatchSyntheticKey(code, 'down'); },
      release: (code) => { dispatchSyntheticKey(code, 'up'); },
      click: (x, y) => { dispatchSyntheticClick(x, y); },
      log: (msg) => { logEvent('policy', { name: '(policy)', message: String(msg) }); },
      disableSelf: () => { /* bound per policy below */ },
    };
  }
  function dispatchSyntheticKey(code, phase) {
    const keyMap = { Space: ' ', Enter: 'Enter', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
    const key = keyMap[code] || (code.length === 1 ? code : code.replace(/^Key|^Digit/, ''));
    const ev = new KeyboardEvent(phase === 'down' ? 'keydown' : 'keyup', { code, key, bubbles: true, cancelable: true });
    global.dispatchEvent(ev);
    logEvent('input', { type: 'key', code, phase, synthetic: true });
  }
  function dispatchSyntheticClick(x, y) {
    const c = state.renderer && state.renderer.domElement;
    const target = c || document.body;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 1 };
    target.dispatchEvent(new PointerEvent('pointerover', opts));
    target.dispatchEvent(new PointerEvent('pointerenter', opts));
    target.dispatchEvent(new PointerEvent('pointermove', opts));
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    logEvent('input', { type: 'click', x, y, synthetic: true });
  }
  function runPolicies(triggerKind) {
    if (!state.controlled && !state.attached) return;
    const ready = state.policies.filter((p) => p.enabled && !p.paused);
    if (!ready.length) return;
    const st = makePolicyState();
    for (const p of ready) {
      if (p.trigger.kind !== triggerKind) continue;
      if (p.trigger.kind === 'event') continue; // event triggers handled in logEvent path (v1: frame only)
      let shouldRun = true;
      if (p.trigger.kind === 'condition') {
        try { shouldRun = !!p.trigger.condFn(st, makePolicyApi()); } catch (e) { policyFault(p, e); continue; }
      }
      if (!shouldRun) continue;
      const api = makePolicyApi();
      const self = p;
      api.disableSelf = () => { self.enabled = false; };
      const t0 = global.performance.now();
      try { p.fn(st, api); } catch (e) { policyFault(p, e); continue; }
      const dt = global.performance.now() - t0;
      p.timeAcc += dt; p.timeN++;
      if (p.timeN >= 30) {
        const avg = p.timeAcc / p.timeN;
        if (avg > 2) { p.paused = true; logEvent('policy', { name: p.name, fault: 'budget', avgMs: +avg.toFixed(2), reason: 'avg > 2ms/frame' }); }
        p.timeAcc = 0; p.timeN = 0;
      }
    }
  }
  function policyFault(p, e) {
    p.faults++;
    logEvent('policy', { name: p.name, fault: 'throw', message: String(e && e.message || e), count: p.faults });
    if (p.faults >= 3) { p.enabled = false; logEvent('policy', { name: p.name, fault: 'disabled', reason: '3 consecutive faults' }); }
  }
  function policyAttach(p) {
    const pol = compilePolicy(p);
    if (state.policies.some((x) => x.name === p.name)) throw err('INVALID_PARAMS', 'policy already exists: ' + p.name);
    state.policies.push(pol);
    state.policies.sort((a, b) => b.priority - a.priority);
    return { name: pol.name, trigger: pol.trigger.kind, enabled: pol.enabled, frameIndex: state.frameIndex };
  }

  /* ============================= record / replay ============================= */
  function ensureSeededForRecord() {
    if (state.seedValue == null) {
      const s = (Math.random() * 0x7fffffff) | 0;
      seedRng(s);
    }
    return state.seedValue;
  }
  function recordStart(params) {
    if (state.rec) throw err('INVALID_PARAMS', 'recording already active; call record.stop first');
    state.rec = {
      id: 'rec-' + (state.recordings.length + 1),
      startFrame: state.frameIndex,
      nominalDt: state.nominalDt,
      seed: ensureSeededForRecord(),
      inputs: [], events: [], keyframes: [], hashes: [],
      includeFrames: !!params.includeFrames,
      keyEvery: 60,
    };
    logEvent('custom', { record: 'start', id: state.rec.id, seed: state.rec.seed });
    return { recordingId: state.rec.id, seed: state.rec.seed, startFrame: state.rec.startFrame };
  }
  function recordStop() {
    if (!state.rec) throw err('INVALID_PARAMS', 'no active recording');
    const r = state.rec;
    state.rec = null;
    state.recordings.push(r);
    const inputCount = r.inputs.reduce((a, l) => a + l.length, 0);
    logEvent('custom', { record: 'stop', id: r.id, frames: state.frameIndex - r.startFrame });
    return { recordingId: r.id, frames: state.frameIndex - r.startFrame, inputs: inputCount, keyframes: r.keyframes.length };
  }
  function recordTick() {
    const r = state.rec;
    if (!r) return;
    r.hashes.push(state.ring.hashSeq[state.ring.hashSeq.length - 1] || 0);
    if (r.includeFrames && (state.frameIndex - r.startFrame) % r.keyEvery === 0) {
      try {
        const { w, h } = canvasSize();
        const width = Math.min(w, 320);
        const height = Math.round(width * h / w);
        const rt = getCaptureRT(width, height);
        renderToRT(rt, width, height, null);
        r.keyframes.push({ frame: state.frameIndex, jpeg: makeCapture(rt, width, height, 'image/jpeg', 0.6).data });
      } catch (e) { /* keyframe best-effort */ }
    }
  }
  function recordToTrace(r) {
    // normalize frame numbers to be relative to the recording start so the
    // trace is portable across sessions (replay in a fresh page starts at 0);
    // per-frame input arrays → flat list per §9.5
    const off = r.startFrame || 0;
    return {
      version: 1, seed: r.seed, nominalDt: r.nominalDt, recordingId: r.id, startFrame: r.startFrame || 0,
      inputs: r.inputs.flatMap((list, i) => list.map((e) => ({ ...e, frame: i }))),
      keyframes: r.keyframes.map((k) => ({ ...k, frame: k.frame - off })),
      events: r.events, hashes: r.hashes,
    };
  }
  function recordLoad(t) {
    if (!t || !Array.isArray(t.inputs) || !Array.isArray(t.hashes)) {
      throw err('INVALID_PARAMS', 'record.load requires a trace object with inputs + hashes');
    }
    const perFrame = [];
    for (const e of t.inputs) {
      const f = e.frame | 0;
      while (perFrame.length <= f) perFrame.push([]);
      if (e.type === 'key') perFrame[f].push({ type: 'key', code: e.code, phase: e.phase });
      else perFrame[f].push({ type: 'click', x: e.x, y: e.y });
    }
    const rec = {
      id: t.recordingId || ('rec-loaded-' + (state.recordings.length + 1)),
      startFrame: t.startFrame || 0, nominalDt: t.nominalDt || 16.67,
      seed: t.seed != null ? t.seed : null,
      inputs: perFrame, events: t.events || [], keyframes: t.keyframes || [],
      hashes: t.hashes, includeFrames: !!t.keyframes,
    };
    state.recordings.push(rec);
    return { loaded: true, recordingId: rec.id, inputs: t.inputs.length, frames: rec.hashes.length, seed: rec.seed };
  }
  function replayRun(params) {
    const rec = state.recordings.find((r) => r.id === params.recordingId);
    if (!rec) throw err('INVALID_PARAMS', 'recording not found: ' + params.recordingId);
    if (!state.controlled) takeControl();
    state.replay = { rec, untilFrame: params.untilFrame != null ? params.untilFrame : Infinity, diverged: null };
    if (rec.seed != null) seedRng(rec.seed);
    // Anchor the bridge frame counter to the recording's start frame: the
    // number of passive frames before takeControl is timing-dependent, so
    // without this the replay's frame numbering drifts from the recording's.
    state.frameIndex = rec.startFrame;
    state.clock = rec.startFrame * (rec.nominalDt || state.nominalDt);
    return { replaying: true, recordingId: rec.id, seeded: rec.seed, untilFrame: state.replay.untilFrame, frameIndex: state.frameIndex };
  }
  function replayInject(frame) {
    const r = state.replay;
    if (!r) return;
    const idx = frame - r.rec.startFrame;
    if (idx >= 0 && idx < r.rec.inputs.length) {
      for (const inp of r.rec.inputs[idx]) {
        if (inp.type === 'key') dispatchSyntheticKey(inp.code, inp.phase);
        else if (inp.type === 'click') dispatchSyntheticClick(inp.x, inp.y);
      }
    }
    if (frame >= r.untilFrame || frame >= r.rec.startFrame + r.rec.hashes.length) {
      state.replay = null;
      logEvent('custom', { replay: 'done', frame, diverged: !!r.diverged });
    }
  }
  // divergence check — hashes[k] is the hash of frame (startFrame+1+k);
  // called AFTER computeHash() so the just-completed frame's hash exists
  function replayDivergenceCheck(frame) {
    const r = state.replay;
    if (!r) return;
    const hidx = frame - r.rec.startFrame - 1;
    if (hidx < 0 || hidx >= r.rec.hashes.length) return;
    const expected = r.rec.hashes[hidx];
    const actual = state.ring.hashSeq[state.ring.hashSeq.length - 1] || 0;
    if (expected !== actual) {
      r.diverged = { frame, expectedHash: expected, actualHash: actual };
    }
  }
  function replayPoll() {
    const r = state.replay;
    if (!r) return { replaying: false };
    if (r.diverged) {
      const d = r.diverged;
      state.replay = null;
      return { replaying: false, diverged: true, frame: d.frame, expectedHash: d.expectedHash, actualHash: d.actualHash };
    }
    return { replaying: true, untilFrame: r.untilFrame, frame: state.frameIndex };
  }
  function replayLast(params) {
    const seconds = params.seconds || 5;
    const since = state.clock - seconds * 1000;
    const frames = state.ring.frames.filter((f) => f.t >= since);
    const events = state.ring.events.filter((e) => e.t >= since);
    return { frames, events, frameIndex: state.frameIndex };
  }

  /* ============================= eval / wait / perf ============================= */
  function evalJS(code) {
    const T = three();
    const tj = {
      rand: state.tjRand, seed: (s) => seedRng(s), frame: () => state.frameIndex,
      step: (n, dt) => step({ frames: n, dt }), dispatch: dispatch, time: () => state.clock,
      object: (id) => { try { return objectInfo(id); } catch (e) { return null; } },
    };
    const fn = new Function('scene', 'camera', 'renderer', 'THREE', 'tj', 'window', 'document', '"use strict";\n' + code);
    const result = fn(state.scene, state.camera, state.renderer, T, tj, global, document);
    return deepClone(result);
  }
  function waitFor(params) {
    const cond = params.condition;
    const timeoutMs = params.timeoutMs || 10000;
    const start = global.performance.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        try {
          if (evalCondition(cond)) return resolve({ ok: true, frameIndex: state.frameIndex, t: state.clock });
        } catch (e) { return reject(e); }
        if (global.performance.now() - start > timeoutMs) return reject(err('TIMEOUT', 'wait.for timed out after ' + timeoutMs + 'ms: ' + cond));
        state.origRaf ? state.origRaf(poll) : setTimeout(poll, 16);
      };
      poll();
    });
  }
  function evalCondition(cond) {
    const s = String(cond).trim();
    // object:<id|name>.<propPath> <op> <num|true|false>
    let m = s.match(/^object:(.+?)\s*(==|!=|>=|<=|>|<)\s*([-0-9.]+|true|false)$/);
    if (m) {
      // resolve the object name progressively (names may contain dots)
      let obj = null, segs = null;
      const parts = m[1].split('.');
      for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = parts.slice(0, i + 1).join('.');
        const found = findObj(candidate);
        if (found) { obj = found; segs = parts.slice(i + 1); break; }
      }
      if (!obj) return false;
      let v = obj;
      for (const seg of segs) { if (v == null) return false; v = v[seg]; }
      if (typeof v === 'number') {
        const rhs = parseFloat(m[3]);
        switch (m[2]) {
          case '>': return v > rhs; case '<': return v < rhs;
          case '>=': return v >= rhs; case '<=': return v <= rhs;
          case '==': return v === rhs; case '!=': return v !== rhs;
        }
      }
      if (typeof v === 'boolean') {
        const rhs = m[3] === 'true';
        if (m[2] === '==') return v === rhs;
        if (m[2] === '!=') return v !== rhs;
      }
      return false;
    }
    // object:<id|name> exists
    m = s.match(/^object:(.+?)\s+exists$/);
    if (m) return !!findObj(m[1]);
    // event:<type>
    m = s.match(/^event:(\w+)$/);
    if (m) return state.ring.events.some((e) => e.type === m[1]);
    // fps > N
    m = s.match(/^fps\s*(>=|>)\s*([0-9.]+)$/);
    if (m) {
      const arr = state.frameTimes.slice(-60);
      if (arr.length < 10) return false;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return avg > 0 && 1000 / avg >= parseFloat(m[2]);
    }
    // JS predicate (policy-style)
    if (/^[a-zA-Z_(]/.test(s)) {
      const fn = new Function('state', 'api', 'return (' + s + ');');
      const st = makePolicyState();
      try { return !!fn(st, makePolicyApi()); } catch (e) { throw err('INVALID_PARAMS', 'condition does not compile: ' + e.message); }
    }
    throw err('INVALID_PARAMS', 'unrecognized condition grammar: ' + s, { grammar: 'object:<name|id>.<prop> <op> <num> | object:<name> exists | event:<type> | fps > N | <js predicate>' });
  }
  function perfReport() {
    const r = state.renderer;
    const frameTimes = state.frameTimes.slice(-240);
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const out = {
      frameIndex: state.frameIndex,
      fps: avg > 0 ? +(1000 / avg).toFixed(1) : 0,
      frameMs: { p50: +p50.toFixed(2), p95: +p95.toFixed(2), avg: +avg.toFixed(2) },
      heuristics: { fetchCalls: state.fetchCount, wsCreated: state.wsCount, seeded: state.seedValue != null, controlled: state.controlled },
    };
    if (r && r.info) {
      out.render = { calls: r.info.render.calls, triangles: r.info.render.triangles, points: r.info.render.points, lines: r.info.render.lines };
      out.memory = { geometries: r.info.memory.geometries, textures: r.info.memory.textures };
    }
    return out;
  }
  function installTelemetry() {
    if (state.fetchOrig) return;
    state.fetchOrig = global.fetch;
    global.fetch = function () { state.fetchCount++; return state.fetchOrig.apply(this, arguments); };
    state.wsOrig = global.WebSocket;
    global.WebSocket = function () { state.wsCount++; return new state.wsOrig(...arguments); };
    global.WebSocket.prototype = state.wsOrig.prototype;
  }

  /* ============================= render.set ============================= */
  function renderSet(p) {
    const r = state.renderer;
    if (!r) return { ok: false };
    if (p.quality) {
      const q = String(p.quality).toLowerCase();
      const map = { low: [0.5, false], medium: [1, true], high: [2, true] };
      if (map[q]) {
        r.setPixelRatio(map[q][0]);
        if (r.shadowMap) r.shadowMap.enabled = map[q][1];
      }
    }
    if (p.wireframe !== undefined) {
      state.scene.traverse((o) => {
        if (o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) { if (m.wireframe !== undefined) { if (!state._wfOrig) state._wfOrig = new Map(); if (!state._wfOrig.has(m)) state._wfOrig.set(m, m.wireframe); m.wireframe = !!p.wireframe; m.needsUpdate = true; } }
        }
      });
    }
    return { ok: true, pixelRatio: r.getPixelRatio(), frameIndex: state.frameIndex };
  }

  /* ============================= streams ============================= */
  function streamStart(params) {
    const id = 'stream-' + (++state.streamSeq);
    const fps = params.fps || 10;
    const width = params.width || 640;
    const timer = setInterval(() => {
      try {
        const cap = captureRGB({ width, format: params.format === 'png' ? 'png' : 'jpeg', quality: 0.7 });
        const payload = { streamId: id, frameIndex: cap.frameIndex, mimeType: cap.mimeType, width: cap.width, height: cap.height, data: cap.data };
        if (typeof global.__tjab_stream_push === 'function') global.__tjab_stream_push(payload);
      } catch (e) { /* frame dropped */ }
    }, 1000 / fps);
    state.streams[id] = { timer, fps, width };
    logEvent('custom', { stream: 'start', id, fps });
    return { streamId: id, fps, width };
  }
  function streamStop(params) {
    const s = state.streams[params.streamId];
    if (!s) throw err('STREAM_NOT_FOUND', 'stream not found: ' + params.streamId);
    clearInterval(s.timer);
    delete state.streams[params.streamId];
    logEvent('custom', { stream: 'stop', id: params.streamId });
    return { stopped: true, streamId: params.streamId };
  }

  /* ============================= gamepad spoof ============================= */
  function gamepadInstall() {
    if (state.gamepad) return state.gamepad;
    const gp = {
      id: 'TJAB-Spoofed-Gamepad', index: 0, connected: true, timestamp: 0,
      mapping: 'standard', axes: new Float64Array(4), buttons: [],
    };
    for (let i = 0; i < 16; i++) gp.buttons.push({ pressed: false, touched: false, value: 0 });
    const orig = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;
    const wrap = function () {
      const arr = orig ? orig() : [];
      if (state.gamepad) arr[state.gamepad.index] = state.gamepad;
      return arr;
    };
    Object.defineProperty(navigator, 'getGamepads', { value: wrap, configurable: true, writable: true });
    state.gamepad = gp;
    const ev = new Event('gamepadconnected');
    global.dispatchEvent(ev);
    return gp;
  }
  function gamepadWrite(params) {
    const gp = gamepadInstall();
    const idx = params.index || 0;
    const target = idx === gp.index ? gp : (state.gamepad = Object.assign({}, gp, { index: idx }));
    if (params.buttons) for (const [i, v] of Object.entries(params.buttons)) {
      const b = target.buttons[+i]; if (!b) continue;
      b.pressed = !!v; b.value = typeof v === 'number' ? v : (v ? 1 : 0); b.touched = b.pressed;
    }
    if (params.axes) for (const [i, v] of Object.entries(params.axes)) { if (target.axes[+i] !== undefined) target.axes[+i] = v; }
    target.timestamp = (global.performance.now() * 1000) | 0;
    return { index: target.index, buttons: target.buttons.map((b) => b.pressed), axes: Array.from(target.axes) };
  }

  /* ============================= audio tap ============================= */
  function audioInstall() {
    if (state.audio) return state.audio;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    const origCtor = AC;
    const Wrapped = function () {
      const ctx = new origCtor();
      let analyser = null, gain = null;
      try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        gain = ctx.createGain();
        gain.gain.value = 1;
        analyser.connect(gain);
        gain.connect(ctx.destination);
        Object.defineProperty(ctx, 'destination', { configurable: true, get: () => analyser });
        if (state.audio) { state.audio.ctx = ctx; state.audio.analyser = analyser; }
      } catch (e) { /* tap failed; use vanilla ctx */ }
      return ctx;
    };
    Wrapped.prototype = origCtor.prototype;
    global.AudioContext = Wrapped;
    if (global.webkitAudioContext) global.webkitAudioContext = Wrapped;
    state.audio = { ctx: null, analyser: null, level: 0, spectrum: null };
    return state.audio;
  }
  function audioTap() {
    const a = state.audio;
    if (!a) return null;
    if (!a.analyser) {
      // no app context created yet — create one to have a stable reading path
      try {
        const ac = global.AudioContext;
        a.ctx = new ac();
        a.analyser = a.ctx.createAnalyser();
        a.analyser.fftSize = 256;
      } catch (e) { return { level: 0, frameIndex: state.frameIndex }; }
    }
    const analyser = a.analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const level = Math.sqrt(sum / data.length);
    a.level = level;
    return { level: +level.toFixed(4), frameIndex: state.frameIndex };
  }
  function audioSpectrum() {
    const a = state.audio;
    if (!a || !a.analyser) return null;
    const data = new Uint8Array(a.analyser.frequencyBinCount);
    a.analyser.getByteFrequencyData(data);
    a.spectrum = Array.from(data);
    return { spectrum: a.spectrum, frameIndex: state.frameIndex };
  }

  /* ============================= attach & singleton ============================= */
  function attach(renderer, scene, camera, opts) {
    opts = opts || {};
    state.renderer = renderer;
    state.scene = scene;
    state.camera = camera;
    state.source = 'sdk';
    state.attached = true;
    if (opts.three) state.THREE = opts.three;
    if (opts.playerRef) state.playerRef = opts.playerRef;
    if (opts.ringBuffer) state.ring.maxFrames = opts.ringBuffer.frames || 0;
    if (opts.nominalDt) state.nominalDt = opts.nominalDt;
    if (opts.viewportId) state.viewportId = opts.viewportId;
    installRafWrap();
    installTelemetry();
    installEventHooks();
    audioInstall(); // patch AudioContext BEFORE the app's first context creation
    warmupCaptureRTs(); // WebGLRenderTarget construction consumes Math.random (uuid) — do it BEFORE any seeding
    // Wrap the renderer's own setAnimationLoop (an own property in three r16x+;
    // prototype method in older releases) so every loop registration is known.
    if (renderer.setAnimationLoop && !renderer.__tjabALWrapped) {
      renderer.__tjabALWrapped = true;
      const origAL = renderer.setAnimationLoop.bind(renderer);
      renderer.setAnimationLoop = (cb) => {
        state.appLoop = cb || null;
        if (state.controlled) return undefined; // bridge drives the loop now
        return origAL(cb);
      };
    }
    const T = three();
    if (T && T.WebGLRenderer && T.WebGLRenderer.prototype.setAnimationLoop) {
      // legacy three: loop registered via prototype method
      state.origSetAnimationLoop = T.WebGLRenderer.prototype.setAnimationLoop;
      T.WebGLRenderer.prototype.setAnimationLoop = function (cb) {
        state.appLoop = cb || null;
        if (state.controlled) return undefined;
        return state.origSetAnimationLoop.call(this, cb);
      };
    } else if (renderer._animationLoop) {
      state.appLoop = renderer._animationLoop; // legacy three fallback
    }
    if (global.__TJAB_THREE__ && !state.THREE) state.THREE = global.__TJAB_THREE__;
    const ev = new CustomEvent('tjab:ready', { detail: { version: state.version, viewportId: state.viewportId } });
    global.dispatchEvent(ev);
    return { attached: true, source: state.source, frameIndex: state.frameIndex };
  }
  function autoRegister(renderer, scene, camera) {
    if (state.attached) {
      logEvent('custom', { auto: 'extra-viewport-skipped', note: 'already attached; multiview not in v1' });
      return { attached: false, reason: 'already-attached' };
    }
    state.renderer = renderer;
    state.scene = scene;
    state.camera = camera;
    state.source = 'auto';
    state.attached = true;
    installRafWrap();
    installTelemetry();
    installEventHooks();
    if (renderer.setAnimationLoop && !renderer.__tjabALWrapped) {
      renderer.__tjabALWrapped = true;
      const origAL = renderer.setAnimationLoop.bind(renderer);
      renderer.setAnimationLoop = (cb) => {
        state.appLoop = cb || null;
        if (state.controlled) return undefined;
        return origAL(cb);
      };
    }
    if (renderer._animationLoop) state.appLoop = renderer._animationLoop; // legacy three
    const T = three();
    if (T && T.WebGLRenderer && T.WebGLRenderer.prototype.setAnimationLoop) {
      state.origSetAnimationLoop = T.WebGLRenderer.prototype.setAnimationLoop;
      T.WebGLRenderer.prototype.setAnimationLoop = function (cb) {
        state.appLoop = cb || null;
        if (state.controlled) return undefined;
        return state.origSetAnimationLoop.call(this, cb);
      };
    }
    const ev = new CustomEvent('tjab:ready', { detail: { version: state.version, source: 'auto' } });
    global.dispatchEvent(ev);
    return { attached: true, source: 'auto' };
  }
  function info() {
    return {
      version: state.version,
      source: state.source,
      attached: state.attached,
      frameIndex: state.frameIndex,
      controlled: state.controlled,
      seeded: state.seedValue != null,
      capabilities: {
        time: true, ring: true, policies: true, input: true,
        gamepad: !!navigator.getGamepads, audio: !!(global.AudioContext || global.webkitAudioContext),
        multiview: false,
      },
      viewports: state.attached ? [state.viewportId] : [],
    };
  }

  /* ============================= dispatcher ============================= */
  function dispatch(method, params) {
    params = params || {};
    try {
      return Promise.resolve(route(method, params));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  function route(method, p) {
    if (!state.attached && !['_info', 'session.new', 'attach', 'time.seed', 'time.takeControl', 'eval.js', 'policy.attach'].includes(method)) {
      throw err('BRIDGE_NOT_FOUND', 'bridge not attached: no renderer/scene/camera registered yet');
    }
    switch (method) {
      /* scene */
      case 'scene.graph': return sceneGraph(p.depth);
      case 'scene.find': return sceneFind(p);
      case 'scene.diff': return sceneDiff(p.since);
      /* objects */
      case 'object.get': return objectInfo(p.id, p.props);
      case 'object.set': return objectSet(p.id, p.patch || {});
      case 'object.add': return objectAdd(p);
      case 'object.remove': return objectRemove(p.id);
      case 'object.focus': return objectFocus(p.id);
      /* camera */
      case 'camera.set': return cameraSet(p);
      case 'camera.fit': return cameraFit(p.id);
      /* capture */
      case 'capture.rgb': return captureRGB(p);
      case 'capture.id': return captureID(p);
      case 'capture.depth': return captureDepth(p);
      case 'capture.stream.start': return streamStart(p);
      case 'capture.stream.stop': return streamStop(p);
      /* input */
      case 'input.project': return projectClick(p.id, !!p.forceRaycast);
      case 'input.raycast': return raycastScreen(p.x, p.y);
      case 'input.gamepad': return gamepadWrite(p);
      /* time */
      case 'time.takeControl': return takeControl();
      case 'time.pause': state.paused = true; return { paused: true, frameIndex: state.frameIndex };
      case 'time.resume': state.paused = false; return { paused: false, frameIndex: state.frameIndex };
      case 'time.step': return step(p);
      case 'time.scale': if (!(p.factor > 0)) throw err('INVALID_PARAMS', 'time.scale factor must be > 0'); state.timeScale = p.factor; return { factor: state.timeScale, frameIndex: state.frameIndex };
      case 'time.seed': return seedRng(p.rng);
      case 'time.now': return { frame: state.frameIndex, t: state.clock, scaled: state.timeScale, controlled: state.controlled, paused: state.paused };
      /* policies */
      case 'policy.attach': return policyAttach(p);
      case 'policy.remove': { const i = state.policies.findIndex((x) => x.name === p.name); if (i < 0) throw err('INVALID_PARAMS', 'policy not found: ' + p.name); state.policies.splice(i, 1); return { removed: p.name }; }
      case 'policy.list': return state.policies.map((x) => ({ name: x.name, trigger: x.trigger.kind, enabled: x.enabled, paused: x.paused, faults: x.faults, priority: x.priority }));
      case 'policy.set': { const pol = state.policies.find((x) => x.name === p.name); if (!pol) throw err('INVALID_PARAMS', 'policy not found: ' + p.name); if (p.enabled !== undefined) pol.enabled = !!p.enabled; if (p.priority !== undefined) pol.priority = p.priority; return { name: pol.name, enabled: pol.enabled }; }
      /* record / replay */
      case 'record.start': return recordStart(p);
      case 'record.stop': return recordStop();
      case 'record.load': return recordLoad(p.trace);
      case 'record.save': {
        const id = p.recordingId || (state.recordings[state.recordings.length - 1] || {}).id;
        const r = state.recordings.find((x) => x.id === id);
        if (!r) throw err('INVALID_PARAMS', 'recording not found: ' + id);
        return recordToTrace(r);
      }
      case 'replay.run': return replayRun(p);
      case 'replay.branch': return replayRun({ recordingId: p.recordingId, untilFrame: p.atFrame });
      case 'replay.poll': return replayPoll();
      case 'replay.last': return replayLast(p);
      case 'replay.export': {
        const id = p.recordingId || (state.recordings[state.recordings.length - 1] || {}).id;
        const r = state.recordings.find((x) => x.id === id);
        if (!r) throw err('INVALID_PARAMS', 'recording not found: ' + id);
        return recordToTrace(r);
      }
      /* runtime */
      case 'eval.js': return evalJS(p.code);
      case 'perf.report': return perfReport();
      case 'console.tail': case 'errors.tail':
        return { frameIndex: state.frameIndex, entries: [] }; // server-side buffering (see server router)
      case 'wait.for': return waitFor(p);
      case 'render.set': return renderSet(p);
      case 'audio.level': { audioInstall(); return audioTap() || { level: 0, frameIndex: state.frameIndex }; }
      case 'audio.spectrum': { audioInstall(); return audioSpectrum() || { spectrum: [], frameIndex: state.frameIndex }; }
      case '_info': return info();
      default: throw err('INVALID_PARAMS', 'unknown method: ' + method);
    }
  }

  /* ============================= public API ============================= */
  const api = {
    version: state.version,
    attach: attach,
    dispatch: dispatch,
    info: info,
    _autoRegister: autoRegister,
    __internal: state,
  };
  if (global.__THREE_AGENT__) {
    // already injected (init script ran first): reuse that singleton
    return global.__THREE_AGENT__.__api || global.__THREE_AGENT__;
  }
  global.__THREE_AGENT__ = api;
  return api;
});
