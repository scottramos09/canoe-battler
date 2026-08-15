'use strict';
// ============================================================
// CANOE ARENA — 3D renderer. EVERYTHING is box geometry.
// ============================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// wave height — imported from ballistics.js (shared with server + prediction)
import { waveH } from './ballistics.js';
import { createOcean } from './ocean.js';

// max shield a pickup grants (mirrors server defs.js PHYS.shieldMax)
const SHIELD_MAX = 60;

// Real volumetric water: tessellated surface (240×240 top face) displaced by a
// 4-octave wave field in the vertex shader, analytic per-fragment normals,
// fresnel depth, crest foam and sun sparkle. The primary 3 octaves match the
// server's waveH() so canoes ride the visible swell; the 4th octave is
// visual-only chop.
const WATER_VERT = `
uniform float uTime;
varying vec3 vWorld;
varying float vH;
varying vec2 vSlope;
void main() {
  vec3 p = position;
  vec2 q = p.xz;
  float h = 0.0;
  // shared ride octaves — byte-matches waveH() (ballistics.js / game.js) ×1.125
  h += sin(q.x*0.045 + uTime*0.7)*0.8*1.125;
  h += sin(q.y*0.055 + uTime*0.85)*0.65*1.125;
  h += sin(q.x*0.10 + uTime*1.1)*0.55*1.125;
  h += sin(q.y*0.08 + uTime*0.9)*0.45*1.125;
  h += sin((q.x+q.y)*0.05 + uTime*0.6)*0.35*1.125;
  h += sin(q.x*0.31 + q.y*0.19 + uTime*2.7)*0.28*1.125;
  // visual-only chop (physics rides only the shared octaves above)
  h += sin(q.x*0.83 - q.y*0.41 + uTime*4.2)*0.09;
  h += sin(q.x*0.47 + q.y*0.62 + uTime*3.4)*0.08;
  h += sin(q.x*0.67 + q.y*0.23 + uTime*5.3)*0.06;
  h += sin(q.x*1.31 - q.y*0.77 + uTime*6.8)*0.05;
  // analytic slopes (derivatives of h) for stable per-fragment normals
  float dx = cos(q.x*0.045 + uTime*0.7)*0.8*0.045*0.9
           + cos((q.x+q.y)*0.05 + uTime*0.6)*0.35*0.05*0.9
           + cos(q.x*0.10 + uTime*1.1)*0.55*0.10*0.9
           + cos(q.x*0.31 + q.y*0.19 + uTime*2.7)*0.28*0.31*0.9
           + cos(q.x*0.83 - q.y*0.41 + uTime*4.2)*0.09*0.83
           + cos(q.x*0.47 + q.y*0.62 + uTime*3.4)*0.08*0.47
           + cos(q.x*0.67 + q.y*0.23 + uTime*5.3)*0.06*0.67
           + cos(q.x*1.31 - q.y*0.77 + uTime*6.8)*0.05*1.31;
  float dz = cos(q.y*0.055 + uTime*0.85)*0.65*0.055*0.9
           + cos((q.x+q.y)*0.05 + uTime*0.6)*0.35*0.05*0.9
           + cos(q.y*0.08 + uTime*0.9)*0.45*0.08*0.9
           + cos(q.x*0.31 + q.y*0.19 + uTime*2.7)*0.28*0.19*0.9
           - cos(q.x*0.83 - q.y*0.41 + uTime*4.2)*0.09*0.41
           + cos(q.x*0.47 + q.y*0.62 + uTime*3.4)*0.08*0.62
           + cos(q.x*0.67 + q.y*0.23 + uTime*5.3)*0.06*0.23
           - cos(q.x*1.31 - q.y*0.77 + uTime*6.8)*0.05*0.77;
  // Gerstner-style lean: crests roll sideways along the slope → real volume
  p.x += dx*0.34;
  p.z += dz*0.34;
  p.y += h*0.9;
  vWorld = (modelMatrix * vec4(p,1.0)).xyz;
  vH = h;
  vSlope = vec2(dx, dz)*0.95;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;
const WATER_FRAG = `
uniform float uTime;
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
uniform sampler2D tNormalMap0; uniform sampler2D tNormalMap1;
uniform vec2 uFlowDir; uniform vec3 uSunDir;
varying vec3 vWorld;
varying float vH;
varying vec2 vSlope;
void main() {
  vec3 n = normalize(vec3(-vSlope.x, 1.0, -vSlope.y));
  vec3 view = normalize(cameraPosition - vWorld);

  // Water2-style flow-blended normal detail (dual maps, half-cycle crossfade)
  float halfCycle = 0.5;
  float flowOff = uTime * 0.05;
  float off0 = fract(flowOff) * halfCycle;
  float off1 = fract(flowOff + 0.5) * halfCycle;
  vec2 fuv = vWorld.xz * 0.09;
  vec4 nc0 = texture2D(tNormalMap0, fuv + uFlowDir * off0);
  vec4 nc1 = texture2D(tNormalMap1, fuv + uFlowDir * off1);
  float flowLerp = abs(halfCycle - off0) / halfCycle;
  vec4 nc = mix(nc0, nc1, flowLerp);
  vec3 nm = normalize(vec3(nc.r*2.0-1.0, nc.g*2.0-1.0, nc.b));
  vec3 t = normalize(vec3(-n.z, 0.0, n.x));
  vec3 b = cross(n, t);
  n = normalize(t*nm.x + b*nm.y + n*nm.z);

  float fres = pow(1.0 - max(dot(n, view), 0.0), 2.0);
  vec3 col = mix(uDeep, uShallow, fres*0.98);
  // distance absorption: the sea darkens into the deep as it recedes
  float distC = length(cameraPosition - vWorld);
  col = mix(col, uDeep, 1.0 - exp(-distC*0.0042));
  // white water: crest-height foam PLUS breaking-wave froth on the steep
  // slopes — where swell octaves collide the surface sharpens and splashes
  float steep = length(vSlope);
  float foamH = smoothstep(0.9, 1.4, vH);
  float foamS = smoothstep(0.28, 0.5, steep);
  float foam = max(foamH, foamS);
  // froth detail from the micro-chop channel so foam patches are patchy
  foam *= 0.72 + 0.28 * nc.g;
  col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.92);
  // broad glitter + sharp sun-specular streak (Water.js style)
  float glitter = pow(max(dot(reflect(-view, n), vec3(0.35,0.8,0.3)), 0.0), 16.0) * 0.78;
  float spec = pow(max(dot(reflect(-uSunDir, n), view), 0.0), 96.0);
  col += vec3(1.0)*glitter + vec3(1.0, 0.95, 0.8)*spec*1.15;
  gl_FragColor = vec4(col, 0.97);
}`;

let PAINTS = [];
export function setPaintDefs(p) { PAINTS = p; }
function paintOf(id) {
  const f = PAINTS.find(x => x.id === id);
  return f || { color: '#e8573d', stripe: '#7a1f10' };
}

// flag + trail defs come from profile.js so the style window and the 3D
// world share ONE source of truth (ids, colors, icon pictures)
let FLAG_DEFS = [];
let TRAIL_DEFS = [];
export function setFlagDefs(f) { FLAG_DEFS = f; }
export function setTrailDefs(t) { TRAIL_DEFS = t; }
function flagDef(id) { return FLAG_DEFS.find(x => x.id === id) || { color: '#ffffff', icon: '▮' }; }
function trailDef(id) { return TRAIL_DEFS.find(x => x.id === id) || null; }

const canvasTex = (w, h, draw) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
};

export function createGame(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  // cap pixel ratio — huge DPR screens tank fill rate on the water shader
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // AA-quality soft shadows (hi tier): PCFSoft 2048 map — the canoes/rocks
  // cast soft-edged shadows instead of hard PCF blocks. The auto quality
  // tier drops back to PCF 1024 in 'lo'.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#7d9db5');
  scene.fog = new THREE.Fog('#7d9db5', 160, 460);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 1000);

  // ---- AA bloom post-processing (hi tier only): a subtle UnrealBloom makes
  // the sun path, muzzle flashes and boost pads GLOW — the single biggest
  // "AA feel" upgrade. Lazy + guarded: any failure falls back to direct
  // rendering; the 'lo' quality tier bypasses it entirely.
  let composer = null;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.6, 0.82));
    composer.addPass(new OutputPass()); // ACES tone mapping + sRGB output (r160)
  } catch (e) { composer = null; console.log('bloom unavailable:', e && e.message); }

  // TJAB — Three.js Agent Bridge (Mode A). Gives an external agent (or this
  // dev session) symbolic scene access + pixel-identical capture so builds
  // can be SELF-VALIDATED: query the projectile meshes' world positions,
  // damage-spot placement, camera framing — no guessing from stills. The
  // bridge is optional and must never break the game if absent/faulty.
  if (window.TJAB && window.TJAB.attach) {
    try {
      // ring OFF (frames: 0): the per-frame offscreen re-render + JPEG tax
      // stuttered real gameplay AND the E2E; validation uses the snap +
      // scene queries instead of the ring buffer.
      window.TJAB.attach(renderer, scene, camera, { three: THREE, ringBuffer: { frames: 0 } });
    } catch (e) { }
  }

  const hemi = new THREE.HemisphereLight('#bfe8ff', '#123a5e', 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff2d0', 1.6);
  sun.position.set(70, 90, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -130; sun.shadow.camera.right = 130;
  sun.shadow.camera.top = 130; sun.shadow.camera.bottom = -130;
  sun.shadow.camera.far = 400;
  scene.add(sun);
  // visible sun: a bright box high in the sky + soft glow halo
  const sunDisc = box(16, 16, 1.6, '#fff6d0', { emissive: '#ffe9a8' });
  sunDisc.position.set(300, 240, 170);
  sunDisc.lookAt(0, 0, 0);
  scene.add(sunDisc);
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#ffedb0', transparent: true, opacity: 0.5, depthWrite: false }));
  sunHalo.position.copy(sunDisc.position);
  sunHalo.scale.set(70, 70, 1);
  scene.add(sunHalo);
  const fill = new THREE.DirectionalLight('#3aa0ff', 0.35);
  fill.position.set(-60, 40, -80);
  scene.add(fill);

  // ---- water ----
  // FFT ocean (Tessendorf spectrum) when float render targets exist; the
  // analytic shader (WATER_VERT/WATER_FRAG) stays as the fallback. The boats
  // keep riding the analytic waveH() either way — the FFT surface is visual.
  // Procedural normal maps for Water2-style flow-blended micro-detail (no assets)
  function makeNormalTex(seed, freq) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const nx = Math.sin(x * freq + seed) * Math.cos(y * freq * 0.8 + seed * 2);
        const ny = Math.sin(y * freq * 1.3 + seed * 3) * Math.cos(x * freq * 0.6 + seed);
        img.data[i] = 128 + nx * 55;
        img.data[i + 1] = 128 + ny * 55;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  const SUN_DIR = new THREE.Vector3(70, 90, 40).normalize();
  // FFT water surface — the Tessendorf displacement/normal/foam sampled over
  // the whole 900 u plane (one tile). The physics stays analytic.
  const WATER_VERT_F = `
uniform sampler2D tDisp;
uniform sampler2D tDispZ;
uniform float uTile;
uniform float uHeight;
uniform float uChoppy;
uniform float uTime;
varying vec3 vWorld;
varying vec2 vUvW;
varying vec2 vSlope;
void main() {
  vec2 uv = position.xz / uTile + 0.5;
  vec4 d = texture2D(tDisp, uv);
  float dz = texture2D(tDispZ, uv).r;
  vec2 q = position.xz;
  // ---- visual-only chop layered on the FFT field: MID swells only (22-52 u).
  // Ripple octaves (λ5-10 u) were REMOVED — they are sub-cell at this mesh
  // resolution (3.75 u/cell) and rendered as visible grid faceting. Fine
  // chaos lives in the FRAGMENT (per-pixel flow normals can't grid).
  // 08-13: amplitudes ×1.2 — wave MAGNITUDE up, wave COUNT unchanged
  // (user: "increase wave magnitude instead of volume of waves").
  float h = 0.0, dx = 0.0, dzz = 0.0;
  h += sin(q.x*0.28 + q.y*0.16 + uTime*1.7)*0.31; dx += cos(q.x*0.28 + q.y*0.16 + uTime*1.7)*0.31*0.28; dzz += cos(q.x*0.28 + q.y*0.16 + uTime*1.7)*0.31*0.16;
  h += sin(q.x*0.19 - q.y*0.31 + uTime*2.2)*0.26; dx += cos(q.x*0.19 - q.y*0.31 + uTime*2.2)*0.26*0.19; dzz -= cos(q.x*0.19 - q.y*0.31 + uTime*2.2)*0.26*0.31;
  h += sin((q.x+q.y)*0.12 + uTime*1.2)*0.22; dx += cos((q.x+q.y)*0.12 + uTime*1.2)*0.22*0.12; dzz += cos((q.x+q.y)*0.12 + uTime*1.2)*0.22*0.12;
  vec3 p = position;
  p.y += d.r * uHeight + h;
  p.x += d.b * uChoppy;
  p.z += dz * uChoppy;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  vUvW = uv;
  vSlope = vec2(dx, dzz);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;
  const WATER_FRAG_F = `
uniform float uTime;
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam;
uniform sampler2D tNormal; uniform sampler2D tRefl;
uniform mat4 uMirrorMatrix;
uniform sampler2D tNorm0; uniform sampler2D tNorm1;
uniform vec2 uFlowDir; uniform vec3 uSunDir;
uniform vec4 uIsles[12]; uniform float uIsleCount;
varying vec3 vWorld;
varying vec2 vUvW;
varying vec2 vSlope;
void main() {
  vec4 nf = texture2D(tNormal, vUvW);
  // surface normal = FFT swell + the analytic chop slopes (matches the
  // vertex geometry, so the ripples actually catch the light)
  vec3 n = normalize(vec3(-(nf.x*2.0-1.0) - vSlope.x, 1.0, -(nf.z*2.0-1.0) - vSlope.y));
  vec3 view = normalize(cameraPosition - vWorld);
  float halfCycle = 0.5;
  float flowOff = uTime * 0.05;
  float off0 = fract(flowOff) * halfCycle;
  float off1 = fract(flowOff + 0.5) * halfCycle;
  vec2 fuv = vWorld.xz * 0.13;
  vec4 nc0 = texture2D(tNorm0, fuv + uFlowDir * off0);
  vec4 nc1 = texture2D(tNorm1, fuv + uFlowDir * off1);
  float flowLerp = abs(halfCycle - off0) / halfCycle;
  vec4 nc = mix(nc0, nc1, flowLerp);
  vec3 nm = normalize(vec3(nc.r*2.0-1.0, nc.g*2.0-1.0, nc.b));
  vec3 t = normalize(vec3(-n.z, 0.0, n.x));
  vec3 b = cross(n, t);
  n = normalize(n + (t*nm.x + b*nm.y + n*nm.z) * 0.75);

  // DARK realistic body color — the sky reflection and sun do the bright
  // work (a bright body is what makes water read as "blue paint")
  float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);
  vec3 col = mix(uDeep, uShallow, fres);
  float dLand = 1e9;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= uIsleCount) break;
    vec4 isl = uIsles[i];
    vec2 dd = abs(vWorld.xz - isl.xy) - isl.zw;
    dLand = min(dLand, max(dd.x, dd.y));
  }
  col = mix(uShallow, col, smoothstep(1.0, 12.0, dLand));
  float distC = length(cameraPosition - vWorld);
  col = mix(col, uDeep, 1.0 - exp(-distC * 0.0018));
  // ---- sky reflection: the sea carries the sky/clouds/sun — the primary
  // realism cue (grazing angles are ~96% mirror)
  vec4 proj = uMirrorMatrix * vec4(vWorld, 1.0);
  proj /= max(proj.w, 1e-5);
  // wave-normal UV distortion — reflections of near objects break up into
  // dim smears like a rough sea, never crisp mirror images (0.06: 3× rougher
  // than v=59, user: "still too reflective")
  vec2 ruv = proj.xy * 0.5 + 0.5 + n.xz * 0.06;
  if (ruv.x > 0.001 && ruv.x < 0.999 && ruv.y > 0.001 && ruv.y < 0.999) {
    vec3 refl = texture2D(tRefl, vec2(ruv.x, 1.0 - ruv.y)).rgb;
    float rfres = pow(1.0 - max(dot(n, view), 0.0), 2.5);
    // 0.22/0.18: reflection strength cut ~2.5× vs v=59 — the sea reads dark
    // and textured; the mirror is a faint sheen, not a surface
    col = mix(col, refl, clamp(rfres * 0.22, 0.0, 0.18));
  }
  // breaking crests: the steepest chop slopes foam (sparse ridges), plus
  // the FFT Jacobian whitecaps and shore wash
  float slope = length(vSlope);
  float foam = smoothstep(0.18, 0.30, slope) * 0.7;
  foam = max(foam, nf.a);
  foam = max(foam, smoothstep(1.8, 0.3, dLand) * 0.5);
  col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.9);
  // ---- sun: a SHARP glitter path (wave facets bouncing the sun into the
  // eye) + the tight specular streak — capped so neither blows out
  float glitter = min(pow(max(dot(reflect(-view, n), uSunDir), 0.0), 48.0) * 0.9, 0.7);
  float spec = min(pow(max(dot(reflect(-uSunDir, n), view), 0.0), 180.0), 0.85);
  col += vec3(1.0, 0.98, 0.92) * (glitter + spec);
  gl_FragColor = vec4(col, 0.97);
}`;
  let ocean = null;
  try { ocean = createOcean(renderer); } catch (e) { console.log('ocean fft unavailable:', e && e.message); }
  const reflRT = new THREE.WebGLRenderTarget(
    Math.max(2, Math.floor(window.innerWidth / 2)), Math.max(2, Math.floor(window.innerHeight / 2)),
    { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  const waterUniforms = {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color('#0b3447') },
    uShallow: { value: new THREE.Color('#1e7f96') },
    uFoam: { value: new THREE.Color('#eafcff') },
    tNormalMap0: { value: makeNormalTex(1.7, 0.09) },
    tNormalMap1: { value: makeNormalTex(4.2, 0.13) },
    uFlowDir: { value: new THREE.Vector2(0.55, 0.83) },
    uSunDir: { value: SUN_DIR },
    tDisp: { value: null }, tDispZ: { value: null }, tNormal: { value: null },
    tRefl: { value: reflRT.texture },
    uMirrorMatrix: { value: new THREE.Matrix4() },
    uTile: { value: 900 }, uHeight: { value: 1.0 }, uChoppy: { value: 0.55 },
    uNormalScale: { value: 1.0 },
    uIsles: { value: [] }, uIsleCount: { value: 0 },
  };
  if (ocean) {
    waterUniforms.tDisp.value = ocean.dispTex;
    waterUniforms.tDispZ.value = ocean.dispZTex;
    waterUniforms.tNormal.value = ocean.normalTex;
  }
  const waterMat = ocean
    ? new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT_F, fragmentShader: WATER_FRAG_F })
    : new THREE.ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG });
  const water = new THREE.Mesh(new THREE.BoxGeometry(900, 2, 900, 288, 1, 288), waterMat);
  water.layers.set(1); // the mirror camera (layer 0) never renders the sea itself
  water.position.y = -1;
  scene.add(water);

  // ---- sky dome: gradient + sun disc + drifting clouds (the sea reflects it) ----
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSunDir: { value: SUN_DIR }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
varying vec3 vDir;
uniform vec3 uSunDir;
uniform float uTime;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 zenith = vec3(0.09, 0.20, 0.42);
  vec3 horizon = vec3(0.66, 0.78, 0.88);
  vec3 col = mix(horizon, zenith, pow(h, 0.55));
  float sd = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.85, 0.6) * pow(sd, 900.0) * 3.0;
  col += vec3(1.0, 0.75, 0.45) * pow(sd, 24.0) * 0.4;
  vec2 cq = d.xz / max(d.y + 0.22, 0.05) * 0.32 + vec2(uTime * 0.004, 0.0);
  float cl = noise(cq * 1.7) * 0.62 + noise(cq * 4.1) * 0.38;
  cl = smoothstep(0.55, 0.86, cl);
  col = mix(col, vec3(0.86, 0.91, 0.96), cl * clamp(h * 3.2, 0.0, 1.0) * 0.85);
  col = mix(col, horizon, pow(1.0 - h, 7.0) * 0.5);
  gl_FragColor = vec4(col, 1.0);
}`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(780, 48, 24), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // ---- reflection mirror camera + water clip plane ----
  const mirrorCam = new THREE.PerspectiveCamera(62, 1, 0.5, 1000);
  const mirrorWorldPosition = new THREE.Vector3();
  const mirrorQuat = new THREE.Quaternion();
  const mirrorInv = new THREE.Matrix4();
  const waterClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  renderer.localClippingEnabled = true;
  camera.layers.enable(1);
  camera.layers.enable(2); // boundary assets — visible to the main camera,
  // excluded from the mirror camera (layer 0) so they never reflect

  // ---- pools ----
  const fx = [];                 // active effects
  const warnFx = [];             // CANNON COVE aim-point telegraphs
  const particles = [];          // debris boxes
  const wakes = [];              // wake trail boxes
  const clouds = [];
  const players = new Map();     // id -> visual
  const projPool = new Map();    // kind -> [mesh]
  const projLive = new Map();    // id -> mesh
  const crateMeshes = new Map(); // id -> group
  let arenaGroup = null;
  let time = 0;
  let renderTime = 16.7; // smoothed ms/frame, for diagnostics
  // ---- performance manager ----
  // frameN parity drives 30 Hz decimation: the FFT ocean phase evolution is a
  // pure function of time, so updating on alternate frames is EXACT, and the
  // reflection texture survives one frame of staleness invisibly (it is
  // already smeared by wave-normal UV distortion). Both run every 2nd frame.
  let frameN = 0;
  // quality tier: 'hi' (FFT N=256, half-res reflection, 288-seg water, DPR 1.25)
  // | 'lo' (N=128, quarter-res reflection, 192-seg water, DPR 1.0). Degrades
  // automatically when the smoothed frame time stays > 30 ms; never auto-upgrades.
  let quality = 'hi';
  let degradeT = 0;

  // ---------------- arena ----------------
  function box(w, h, d, color, opts = {}) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color, ...opts }),
    );
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function palm(x, z, y, s = 1) {
    const g = new THREE.Group();
    const trunk = box(0.42 * s, 3.4 * s, 0.42 * s, '#6b4a2e');
    trunk.position.y = 1.7 * s;
    trunk.rotation.z = 0.12; trunk.rotation.x = 0.05;
    g.add(trunk);
    for (let i = 0; i < 5; i++) {
      const fr = box(1.9 * s, 0.14 * s, 0.55 * s, i % 2 ? '#2e8b3d' : '#3aa04a');
      fr.position.y = 3.5 * s;
      fr.rotation.y = (i / 5) * TAU + 0.3;
      fr.rotation.z = -0.55;
      fr.position.x = Math.cos((i / 5) * TAU) * 0.55 * s;
      fr.position.z = Math.sin((i / 5) * TAU) * 0.55 * s;
      g.add(fr);
    }
    g.position.set(x, y, z);
    return g;
  }

  function buildArena(mapDef) {
    if (arenaGroup) { scene.remove(arenaGroup); disposeGroup(arenaGroup); }
    arenaGroup = new THREE.Group();
    const islesArr = [];
    for (const isl of mapDef.isles || []) islesArr.push(new THREE.Vector4(isl.x, isl.z, isl.w / 2, isl.d / 2));
    for (const rk of mapDef.rocks || []) islesArr.push(new THREE.Vector4(rk.x, rk.z, rk.w / 2, rk.d / 2));
    waterUniforms.uIsles.value = islesArr.slice(0, 12);
    // three.js uploads vec4 ARRAY uniforms over the GLSL-declared size
    // (uIsles[12]) — a short JS array makes the uploader read undefined
    // slots and throw mid-frame ("Cannot read properties of undefined
    // (reading 'toArray')"), killing the water draw (lagoon = 10 entries
    // < 12 crashed the whole scene to sky-only). Pad to the declared size;
    // uIsleCount still guards the GLSL loop so the padding is never read.
    while (waterUniforms.uIsles.value.length < 12) waterUniforms.uIsles.value.push(new THREE.Vector4(0, 0, 0, 0));
    waterUniforms.uIsleCount.value = islesArr.length;
    const A = 100, W = 6;

    // NO visible walls — the sea stretches to the horizon; the play boundary
    // is an invisible wall (server-enforced, feels like open ocean)
    // corner towers (distant landmarks beyond the play area)
    arenaGroup.userData.flags = [];
    for (const [cx, cz] of [[-A - 2, -A - 2], [A + 2, -A - 2], [-A - 2, A + 2], [A + 2, A + 2]]) {
      const tw = box(7, 13, 7, '#243c5c');
      tw.position.set(cx, 6.5, cz);
      arenaGroup.add(tw);
      const top = box(8.5, 1.2, 8.5, '#3a6a9a');
      top.position.set(cx, 13.6, cz);
      arenaGroup.add(top);
      const pole = box(0.25, 4, 0.25, '#7a6a3a');
      pole.position.set(cx, 16, cz);
      arenaGroup.add(pole);
      const flag = box(2.4, 1.1, 0.12, '#c8552a');
      flag.position.set(cx + 1.3, 16.5, cz);
      arenaGroup.add(flag);
      arenaGroup.userData.flags.push(flag); // waves in the breeze
      // beacon glow on the pole top
      const beacon = box(0.55, 0.55, 0.55, '#ffd23f', { emissive: '#ff9d00' });
      beacon.position.set(cx, 18.6, cz);
      arenaGroup.add(beacon);
    }
    // bleachers + crowd pixels
    for (const side of ['n', 's', 'e', 'w']) {
      for (let row = 0; row < 3; row++) {
        const len = 88 - row * 8;
        const b = box(len, 2.6, 3.6, row % 2 ? '#14395c' : '#0e2a48');
        let x = 0, z = 0;
        if (side === 'n') { z = -(A + 9 + row * 4); }
        if (side === 's') { z = A + 9 + row * 4; }
        if (side === 'e') { x = A + 9 + row * 4; b.rotation.y = Math.PI / 2; }
        if (side === 'w') { x = -(A + 9 + row * 4); b.rotation.y = Math.PI / 2; }
        b.position.set(x, 1.3 + row * 1.1, z);
        arenaGroup.add(b);
      }
      const cx = side === 'e' ? A + 11 : side === 'w' ? -(A + 11) : 0;
      const cz = side === 'n' ? -(A + 11) : side === 's' ? A + 11 : 0;
      for (let i = 0; i < 24; i++) {
        const pc = box(0.7, 0.7, 0.7, ['#c8552a', '#3f9fd8', '#ffcf4d', '#3fe08a', '#e0579f'][i % 5]);
        pc.position.set(cx + (side === 'e' || side === 'w' ? 0 : (i - 12) * 3.4),
          3.4 + Math.random() * 1.4,
          cz + (side === 'n' || side === 's' ? 0 : (i - 12) * 3.4));
        arenaGroup.add(pc);
      }
    }
    // islands — sand rim, grass cap, palms, camp, bush
    for (const isl of mapDef.isles || []) {
      const rim = box(isl.w + 1.4, 0.35, isl.d + 1.4, '#e0c878');
      rim.position.set(isl.x, 0.25, isl.z);
      arenaGroup.add(rim);
      const base = box(isl.w, 1.1, isl.d, '#c2a25a');
      base.position.set(isl.x, 0.55, isl.z);
      arenaGroup.add(base);
      const top = box(isl.w * 0.72, 1.0, isl.d * 0.72, '#6a8a4a');
      top.position.set(isl.x, 1.55, isl.z);
      arenaGroup.add(top);
      arenaGroup.add(palm(isl.x + isl.w * 0.22, isl.z - isl.d * 0.2, 2.1, 1.15));
      arenaGroup.add(palm(isl.x - isl.w * 0.24, isl.z + isl.d * 0.24, 2.0, 0.9));
      const camp = box(1.6, 1.3, 1.6, '#7a3a2a');
      camp.position.set(isl.x, 2.2, isl.z + isl.d * 0.1);
      arenaGroup.add(camp);
      const door = box(0.7, 0.9, 0.14, '#4a2018');
      door.position.set(isl.x + 0.7, 1.85, isl.z + isl.d * 0.1);
      arenaGroup.add(door);
      const bush = box(0.9, 0.7, 0.9, '#5a8a42');
      bush.position.set(isl.x - isl.w * 0.3, 2.0, isl.z - isl.d * 0.3);
      arenaGroup.add(bush);
    }
    // sky isles — hanging stalactites under the floating rock
    for (const si of mapDef.skyisles || []) {
      const base = box(si.w, 1.6, si.d, '#7a5a3a');
      base.position.set(si.x, si.y, si.z);
      arenaGroup.add(base);
      const grass = box(si.w * 0.85, 0.7, si.d * 0.85, '#4a7a3a');
      grass.position.set(si.x, si.y + 1.05, si.z);
      arenaGroup.add(grass);
      arenaGroup.add(palm(si.x + si.w * 0.2, si.z - si.d * 0.15, si.y + 1.4, 0.85));
      const wreck = box(2.6, 1.1, 1.2, '#5a4a3a');
      wreck.position.set(si.x - si.w * 0.2, si.y + 1.5, si.z + si.d * 0.2);
      wreck.rotation.y = 0.8;
      arenaGroup.add(wreck);
      const stone = box(1.1, 1.4, 1.1, '#6a6a74');
      stone.position.set(si.x + si.w * 0.3, si.y + 1.3, si.z - si.d * 0.25);
      arenaGroup.add(stone);
      for (let s = 0; s < 3; s++) {
        const sh = 1.0 + Math.random() * 1.4;
        const st = box(0.5 + Math.random() * 0.5, sh, 0.5 + Math.random() * 0.5, '#5a4a3a');
        st.position.set(si.x + (Math.random() - 0.5) * si.w * 0.7, si.y - 0.8 - sh / 2, si.z + (Math.random() - 0.5) * si.d * 0.7);
        st.rotation.z = (Math.random() - 0.5) * 0.2;
        arenaGroup.add(st);
      }
    }
    // rocks — faceted outcrop: main block + moss cap + leaning shard
    for (const rk of mapDef.rocks) {
      const r = box(rk.w, rk.h, rk.d, '#4a5560');
      r.position.set(rk.x, rk.h / 2, rk.z);
      r.rotation.y = Math.random() * 0.4;
      arenaGroup.add(r);
      const r2 = box(rk.w * 0.5, rk.h * 0.45, rk.d * 0.5, '#55606e');
      r2.position.set(rk.x + rk.w * 0.12, rk.h * 0.9, rk.z + rk.d * 0.1);
      arenaGroup.add(r2);
      const moss = box(rk.w * 0.62, 0.5, rk.d * 0.62, '#4a7a3a');
      moss.position.set(rk.x + rk.w * 0.05, rk.h + 0.18, rk.z - rk.d * 0.05);
      moss.rotation.y = Math.random() * 0.5;
      arenaGroup.add(moss);
      const shard = box(rk.w * 0.28, rk.h * 0.7, rk.d * 0.28, '#3c4652');
      shard.position.set(rk.x - rk.w * 0.22, rk.h * 0.55, rk.z + rk.d * 0.18);
      shard.rotation.z = 0.5;
      shard.rotation.y = Math.random() * 0.5;
      arenaGroup.add(shard);
    }
    // BOOST PLATFORMS — a traversable dock/slide asset under each pad:
    // entry wedge rises from the water to a flat top (boats ride it like
    // water), and the pad above it angles UP toward the sky at the exit —
    // the boost fires forward + up from there.
    arenaGroup.userData.boostZones = [];
    for (const z of mapDef.boostZones || []) {
      const h = z.h || 1.3;
      const entryLen = z.d * 0.3;
      const flatLen = z.d - entryLen;
      // entry wedge (from the waterline up to the top on the entry side) —
      // box dims normalized to the zone axis (dir x = long along x)
      const tilt = Math.atan2(h, entryLen);
      const wedge = box(z.dir === 'x' ? entryLen + 0.5 : z.w, 0.5, z.dir === 'x' ? z.w : entryLen + 0.5, '#7a5f3a');
      wedge.position.set(z.x - z.sign * (z.dir === 'x' ? flatLen / 2 : 0), (h - 0.25) / 2, z.z - z.sign * (z.dir === 'x' ? 0 : flatLen / 2));
      if (z.dir === 'x') wedge.rotation.z = z.sign > 0 ? tilt : -tilt;
      else wedge.rotation.x = z.sign > 0 ? -tilt : tilt;
      arenaGroup.add(wedge);
      // flat top (the traversable deck)
      const deck = box(z.dir === 'x' ? flatLen : z.w, 0.35, z.dir === 'x' ? z.w : flatLen, '#8a6a3a');
      deck.position.set(z.x + z.sign * (z.dir === 'x' ? entryLen / 2 : 0), h - 0.175, z.z + z.sign * (z.dir === 'x' ? 0 : entryLen / 2));
      arenaGroup.add(deck);
      const deck2 = box(z.dir === 'x' ? flatLen - 1 : z.w - 1.2, 0.1, z.dir === 'x' ? z.w - 1.2 : flatLen - 1, '#9a7a44');
      deck2.position.set(z.x + z.sign * (z.dir === 'x' ? entryLen / 2 : 0), h + 0.02, z.z + z.sign * (z.dir === 'x' ? 0 : entryLen / 2));
      arenaGroup.add(deck2);
      // the BOOST PAD — angled UP toward the sky at the exit (leading edge up)
      const padTilt = 0.5; // ~29° up
      const pad = box(z.dir === 'x' ? 3.2 : z.w, 0.16, z.dir === 'x' ? z.w : 3.2, '#1f7fb8', { emissive: '#0a3f66' });
      pad.position.set(z.x + z.sign * (z.dir === 'x' ? flatLen / 2 + 1 : 0), h + 0.8, z.z + z.sign * (z.dir === 'x' ? 0 : flatLen / 2 + 1));
      if (z.dir === 'x') pad.rotation.z = z.sign > 0 ? padTilt : -padTilt;
      else pad.rotation.x = z.sign > 0 ? -padTilt : padTilt;
      pad.material.transparent = true;
      pad.material.opacity = 0.8;
      arenaGroup.add(pad);
      arenaGroup.userData.boostZones.push(pad);
      for (let a = 0; a < 3; a++) {
        const arrow = box(0.9, 0.12, 0.9, '#ffd23f', { emissive: '#c8a020' });
        arrow.position.set(
          z.x + (z.dir === 'x' ? z.sign * (a - 1) * 2.0 : 0),
          h + 1.35 + a * 0.5,
          z.z + (z.dir === 'z' ? z.sign * (a - 1) * 2.0 : 0)
        );
        if (z.dir === 'x') arrow.rotation.z = z.sign > 0 ? padTilt : -padTilt;
        else arrow.rotation.x = z.sign > 0 ? -padTilt : padTilt;
        arenaGroup.add(arrow);
      }
    }
    // CANNON COVE batteries — the namesake: stone emplacements with long
    // barrels aimed across the bay. Each is a static model; the SERVER owns
    // the firing cycle (warn → lob), the fx events animate recoil/smoke.
    arenaGroup.userData.cannons = [];
    for (const cn of mapDef.cannons || []) {
      const g = new THREE.Group();
      const base = box(2.6, 1.1, 2.6, '#4a4a54');
      base.position.y = cn.y - 0.55;
      g.add(base);
      const rim = box(3.2, 0.5, 3.2, '#2e2e36');
      rim.position.y = cn.y + 0.15;
      g.add(rim);
      // long fortress barrel, pitched up at the high-arc lob angle
      const barrel = box(0.62, 0.62, 3.1, '#1f1f24', { emissive: '#101014' });
      barrel.position.y = cn.y + 1.15;
      barrel.position.z = 0.9;
      const a0 = cn.aims[0];
      const bYaw = Math.atan2(a0.z - cn.z, a0.x - cn.x);
      const R = Math.hypot(a0.x - cn.x, a0.z - cn.z);
      const sin2 = Math.min(1, (R * 800) / (cn.spd * cn.spd));
      const bPitch = Math.PI / 2 - 0.5 * Math.asin(sin2);
      barrel.rotation.x = -bPitch * 0.9; // tips up toward the sky (group yaw aims it)
      g.add(barrel);
      g.position.set(cn.x, 0, cn.z);
      g.rotation.y = Math.PI / 2 - bYaw; // scene convention: model +z → world aim
      g.userData.def = cn;
      arenaGroup.add(g);
      arenaGroup.userData.cannons.push(g);
    }
    // boundary buoys — bobbing markers ring the invisible wall so the play
    // edge is readable (functionality: no more bumping a hidden wall)
    arenaGroup.userData.buoys = [];
    for (let i = 0; i < 10; i++) {
      for (const [bx, bz] of [[-A + 4 + i * 10, -A + 4], [A - 4 - i * 10, A - 4], [-A + 4, A - 4 - i * 10], [A - 4, -A + 4 + i * 10]]) {
        const bg = new THREE.Group();
        const body = box(1.1, 0.7, 1.1, '#c8552a');
        body.position.y = 0.5;
        bg.add(body);
        const light = box(0.35, 0.35, 0.35, '#ffd23f', { emissive: '#ffb020' });
        light.position.y = 1.15;
        bg.add(light);
        bg.position.set(bx, 0, bz);
        arenaGroup.add(bg);
        arenaGroup.userData.buoys.push(bg);
      }
    }
    // clouds — volumetric puffs: each cloud is a pile of overlapping soft boxes
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const cx = (Math.random() - 0.5) * 600, cy = 60 + Math.random() * 55, cz = (Math.random() - 0.5) * 600;
      g.position.set(cx, cy, cz);
      const puffs = 6 + Math.floor(Math.random() * 4);
      for (let p = 0; p < puffs; p++) {
        const s = 5 + Math.random() * 9;
        const puff = box(s, s * (0.45 + Math.random() * 0.3), s * (0.7 + Math.random() * 0.5), '#ffffff', { transparent: true, opacity: 0.88, emissive: '#dfe9ff' });
        puff.position.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 3.5, (Math.random() - 0.5) * 10);
        puff.rotation.y = Math.random() * TAU;
        g.add(puff);
      }
      // flat base shadow layer
      const base = box(26, 1.6, 16, '#c8d8ee', { transparent: true, opacity: 0.35 });
      base.position.y = -2.2;
      g.add(base);
      clouds.push(g);
      arenaGroup.add(g);
    }
    scene.add(arenaGroup);
    // boundary assets (towers, bleachers, crowd pixels, buoys, clouds) sit
    // outside the play area (>94 u) — tag them layer 2 so the MIRROR camera
    // (layer 0) never reflects them: the user read their crisp reflections
    // as "too reflective" (boundary + floating assets). Sky/islands/rocks/
    // canoes stay in layer 0 — natural water reflections, dimmed by the
    // fresnel curve + uv distortion in WATER_FRAG_F.
    arenaGroup.traverse(o => {
      let x = o.position.x, z = o.position.z, p = o.parent;
      while (p && p !== arenaGroup) { x += p.position.x; z += p.position.z; p = p.parent; }
      if (Math.abs(x) > 94 || Math.abs(z) > 94) o.layers.set(2);
    });
  }

  function disposeGroup(g) {
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }

  // ---------------- labels ----------------
  // Only the TEXTURE is cached/shared — each call makes a FRESH sprite.
  // Sharing the sprite OBJECT broke bars/labels: a three.js object has ONE
  // parent, so the second canoe to grab a cached sprite silently stole it
  // from the first — that's why health bars vanished above other players.
  const labelCache = new Map();
  function nameSprite(name, clsIcon, color) {
    const key = name + clsIcon + color;
    let tex = labelCache.get(key);
    if (!tex) {
      tex = canvasTex(256, 64, (ctx, w, h) => {
        ctx.font = '800 30px "Segoe UI", Arial';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(name, w / 2, h / 2 + 2);
        ctx.fillStyle = color;
        ctx.fillText(name, w / 2, h / 2 + 2);
      });
      labelCache.set(key, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(4.2, 1.05, 1);
    return sp;
  }

  // hp bar sprites — the TEXTURE is cached by rounded percentage bucket so
  // redraws are cheap; each call returns a FRESH sprite (shared sprite
  // objects got stolen between canoes — one parent per object).
  const hpCache = new Map();
  function hpSprite(hpPct, shPct = 0) {
    const hb = clamp(Math.round(hpPct * 20), 0, 20);
    const sb = clamp(Math.round(shPct * 20), 0, 20);
    const key = hb * 21 + sb;
    let tex = hpCache.get(key);
    if (!tex) {
      tex = canvasTex(128, 16, (ctx, w, h) => {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(1, 1, w - 2, h - 2);
        // health fill (full width — the base layer; green → yellow → red)
        const hw = (w - 2) * clamp(hpPct, 0, 1);
        ctx.fillStyle = hpPct > 0.6 ? '#3fe08a' : hpPct > 0.3 ? '#ffd23f' : '#ff5e4d';
        ctx.fillRect(1, 1, hw, h - 2);
        // shield OVERLAY — the darker blue ON TOP of the health fill: the
        // blue shrinks as the shield absorbs damage and the health (whatever
        // remains underneath) shows through the missing segment
        if (shPct > 0) {
          ctx.fillStyle = 'rgba(37, 80, 158, 0.82)';
          ctx.fillRect(1, 1, (w - 2) * clamp(shPct, 0, 1), h - 2);
        }
      });
      hpCache.set(key, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(2.4, 0.3, 1);
    return sp;
  }

  // Damage-number sprites share canvas textures per text+color (capped) —
  // creating a fresh canvas per hit was a GPU-texture LEAK: every hit
  // uploaded a new texture that nothing ever disposed, so late rounds with
  // upgraded guns (more hits, more kills) ground the renderer to a halt.
  const dmgCache = new Map();
  function dmgSprite(text, color) {
    const key = text + '|' + color;
    let tex = dmgCache.get(key);
    if (!tex) {
      if (dmgCache.size > 96) {
        for (const t of dmgCache.values()) t.dispose();
        dmgCache.clear();
      }
      tex = canvasTex(128, 64, (ctx, w, h) => {
        ctx.font = '800 40px "Segoe UI", Arial';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(text, w / 2, h / 2);
        ctx.fillStyle = color;
        ctx.fillText(text, w / 2, h / 2);
      });
      dmgCache.set(key, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(2.2, 1.1, 1);
    return sp;
  }

  // ---------------- canoe models ----------------
  const weaponBuilders = {
    rail(t) {
      const g = new THREE.Group();
      const mount = box(0.55, 0.35, 0.7, '#3a4a5a');
      g.add(mount);
      const barrel = (x, len, col) => {
        // chunky gun barrel (NOT a paddle-stick): thick bore + muzzle collar
        const b = box(0.24, 0.24, len, col, { emissive: col });
        b.position.set(x, 0.15, len / 2 + 0.2);
        return b;
      };
      if (t === 0) g.add(barrel(0, 1.5, '#6ff3ff'));
      if (t === 1) { g.add(barrel(-0.17, 1.5, '#6ff3ff')); g.add(barrel(0.17, 1.5, '#6ff3ff')); }
      if (t === 2) {
        g.add(barrel(0, 2.1, '#7ffbff'));
        g.add(box(0.3, 0.3, 0.5, '#5ad8e8', { emissive: '#5ad8e8' }).translateY(0.28).translateZ(0.5));
        g.add(box(0.3, 0.3, 0.5, '#5ad8e8', { emissive: '#5ad8e8' }).translateY(0.28).translateZ(-0.1));
      }
      if (t === 3) { g.add(barrel(-0.28, 1.7, '#6ff3ff')); g.add(barrel(0, 1.9, '#7ffbff')); g.add(barrel(0.28, 1.7, '#6ff3ff')); }
      if (t >= 4) {
        g.add(barrel(-0.3, 1.9, '#7ffbff')); g.add(barrel(0, 2.1, '#8ffcff')); g.add(barrel(0.3, 1.9, '#7ffbff'));
        g.add(box(0.34, 0.34, 0.4, '#ffd23f', { emissive: '#ffd23f' }).translateY(0.3).translateZ(0.8));
      }
      return g;
    },
    cannon(t, big) {
      const g = new THREE.Group();
      const mount = box(0.9, 0.5, 1.0, '#2a2a30');
      g.add(mount);
      const barrel = (x, tilt) => {
        const b = box(big ? 0.85 : 0.5, big ? 0.85 : 0.5, big ? 2.4 : 1.9, '#2e2a26');
        b.position.set(x, 0.42, 0.75);
        b.rotation.x = tilt;
        return b;
      };
      if (t === 0) g.add(barrel(0, 0.7));
      if (t === 1) { g.add(barrel(-0.32, 0.65)); g.add(barrel(0.32, 0.7)); }
      if (t === 2) { g.add(barrel(-0.55, 0.6)); g.add(barrel(0, 0.68)); g.add(barrel(0.55, 0.62)); }
      if (t === 3) {
        g.add(barrel(-0.35, 0.75)); g.add(barrel(0.35, 0.78));
        g.add(box(0.8, 0.5, 0.5, '#3a3526').translateY(0.5).translateZ(-0.3));
      }
      if (t >= 4) g.add(barrel(0, 0.85));
      return g;
    },
    rocket(t) {
      const g = new THREE.Group();
      const pod = box(1.05, 0.5, 0.75, '#5a4a3a');
      g.add(pod);
      const nozz = (x, y) => {
        const b = box(0.26, 0.26, 0.28, '#1a1a1a');
        b.position.set(x, y, 0.55);
        return b;
      };
      const tips = t >= 4;
      const tip = (x, y) => {
        const b = box(0.24, 0.24, 0.3, '#c8302a', { emissive: '#c8302a' });
        b.position.set(x, y, 0.55);
        return b;
      };
      if (t === 0) g.add(nozz(0, 0));
      if (t === 1) { g.add(nozz(-0.22, 0)); g.add(nozz(0.22, 0)); }
      if (t === 2) { g.add(nozz(-0.3, 0.12)); g.add(nozz(0.3, 0.12)); g.add(nozz(-0.3, -0.12)); g.add(nozz(0.3, -0.12)); }
      if (t === 3) {
        for (const [x, y] of [[-0.35, 0.14], [0.35, 0.14], [-0.35, -0.14], [0.35, -0.14], [0, 0.14], [0, -0.14]]) g.add(nozz(x, y));
      }
      if (t >= 4) {
        for (const [x, y] of [[-0.3, 0.12], [0.3, 0.12], [0, -0.12]]) g.add(tip(x, y));
      }
      return g;
    },
    shot(t) {
      const g = new THREE.Group();
      const body = box(0.55, 0.4, 0.9, '#3a3a42');
      g.add(body);
      const bar = (x) => {
        const b = box(0.24, 0.24, 1.1, '#2a2a30');
        b.position.set(x, 0.1, 0.9);
        return b;
      };
      if (t <= 1) g.add(bar(0));
      if (t === 2) { g.add(bar(-0.15)); g.add(bar(0.15)); }
      if (t === 3) { g.add(bar(-0.22)); g.add(bar(0.22)); g.add(box(0.35, 0.2, 0.3, '#3a3526').translateY(0.3).translateZ(-0.2)); }
      if (t >= 4) {
        g.add(bar(-0.28)); g.add(bar(-0.1)); g.add(bar(0.1)); g.add(bar(0.28));
        g.add(box(0.4, 0.5, 0.4, '#4a3526').translateY(0.35).translateZ(-0.35));
      }
      return g;
    },
    mine(t) {
      const g = new THREE.Group();
      const chute = box(0.7, 0.45, 0.9, '#2a2a30');
      chute.rotation.x = -0.9;
      g.add(chute);
      if (t >= 2) {
        const tube = box(0.44, 0.44, 1.5, '#3a4a5a');
        tube.position.set(0, 0.3, 0.7);
        g.add(tube);
        g.add(box(0.3, 0.3, 0.3, '#c8302a').translateY(0.3).translateZ(1.45));
        if (t >= 3) {
          const t2 = tube.clone(); t2.position.x = 0.4; t2.rotation.y = 0.12;
          g.add(t2);
        }
      }
      return g;
    },
    harpoon() {
      const g = new THREE.Group();
      const body = box(0.5, 0.4, 1.0, '#3a3a42');
      g.add(body);
      const bar = box(0.3, 0.3, 1.7, '#e8e8e8');
      bar.position.set(0, 0.12, 1.1);
      g.add(bar);
      const tip = box(0.26, 0.26, 0.5, '#c8302a');
      tip.position.set(0, 0.12, 2.0);
      g.add(tip);
      return g;
    },
  };

  // Weapon build with UPGRADE LEVELS (0-10): every level adds menace —
  // trim, side barrels, spikes, a second row, and finally a ridiculous
  // rotating ring + overdrive core at 10. Damage scales with the same level.
  function buildWeapon(cls, slot, tier, level = 0) {
    const g = new THREE.Group();
    if (slot === 'w1') {
      if (cls === 'razorfin') g.add(weaponBuilders.rail(tier));
      else if (cls === 'barge') g.add(weaponBuilders.cannon(tier, tier >= 4));
      else g.add(weaponBuilders.rocket(tier));
    } else {
      if (cls === 'razorfin') g.add(weaponBuilders.mine(tier));
      else if (cls === 'barge') g.add(tier >= 4 ? weaponBuilders.harpoon() : weaponBuilders.shot(tier));
      else g.add(weaponBuilders.shot(tier));
    }
    // progressive imposing-ness: tier AND kill-upgrade level both read bigger
    const s = 1 + tier * 0.14 + level * 0.16;
    g.scale.set(s, s, s);
    if (tier >= 3) {
      const trim = box(1.35, 0.1, 0.1, '#ffcf4d');
      trim.position.set(0, 0.42, 0);
      g.add(trim);
    }
    if (tier >= 4) {
      const core = box(0.42, 0.42, 0.42, '#ff6a2a', { emissive: '#ff6a2a' });
      core.position.set(0, 0.5, -0.25);
      g.add(core);
    }
    // ---- KILL-UPGRADE escalation (each level is visibly meaner) ----
    if (level >= 1) {
      const trim = box(1.5, 0.1, 0.1, '#c8a020', { emissive: '#c8a020' });
      trim.position.set(0, 0.45, 0);
      g.add(trim);
    }
    if (level >= 2) {
      for (const sx of [-1, 1]) {
        const stub = box(0.2, 0.2, 0.55, '#4a5a6a');
        stub.position.set(sx * 0.5, 0.12, 0.65);
        g.add(stub);
      }
    }
    if (level >= 4) {
      for (const sx of [-1, 1]) {
        const side = box(0.26, 0.26, 1.0, '#3a4a5a');
        side.position.set(sx * 0.62, 0.12, 0.75);
        g.add(side);
      }
    }
    if (level >= 6) {
      for (let i = 0; i < 4; i++) {
        const spike = box(0.14, 0.14, 0.55, '#ff6a2a', { emissive: '#ff6a2a' });
        spike.position.set(Math.cos(i * Math.PI / 2) * 0.72, 0.22, 0.5);
        spike.rotation.y = i * Math.PI / 2;
        g.add(spike);
      }
    }
    if (level >= 8) {
      for (const sx of [-0.6, 0, 0.6]) {
        const row = box(0.28, 0.28, 1.3, '#5a6a7a');
        row.position.set(sx, 0.6, 0.65);
        g.add(row);
      }
      const brace = box(1.9, 0.12, 0.12, '#ffcf4d', { emissive: '#ffcf4d' });
      brace.position.y = 0.75;
      g.add(brace);
    }
    if (level >= 10) {
      // LEVEL 10 — RIDICULOUS: rotating ring + fins. The hot-pink overdrive
      // core cube was REMOVED (user: "the giant pink cube needs to go away").
      const ring = box(2.4, 0.16, 0.16, '#7ffbff', { emissive: '#7ffbff' });
      ring.position.set(0, 0.95, 0.1);
      g.add(ring);
      for (const sx of [-1, 1]) {
        const fin = box(0.1, 0.9, 0.5, '#7ffbff', { emissive: '#7ffbff' });
        fin.position.set(sx * 1.15, 0.3, -0.3);
        fin.rotation.z = sx * 0.4;
        g.add(fin);
      }
    }
    return g;
  }

  // FIGUREHEADS mount on the BOW (the front) — classic figurehead placement
  // (user changed their mind: "Figureheads should appear on the front of the
  // canoe, not the back").
  function figurehead(id) {
    const g = new THREE.Group();
    const at = (x, y, z) => { g.position.set(x, y, z); };
    if (id === 'skull') {
      const s = box(0.55, 0.55, 0.55, '#e8e8e8'); g.add(s);
      g.add(box(0.14, 0.14, 0.14, '#1a1a1a').translateY(0.12).translateX(-0.13).translateZ(0.28));
      g.add(box(0.14, 0.14, 0.14, '#1a1a1a').translateY(0.12).translateX(0.13).translateZ(0.28));
      at(0, 1.0, 1.6);
    } else if (id === 'dragon') {
      g.add(box(0.6, 0.5, 1.0, '#2e8b3d').translateY(0.5).translateZ(0.4));
      g.add(box(0.2, 0.45, 0.2, '#e8d23a').translateY(1.0).translateZ(0.2).rotateX(0.4));
      g.add(box(0.5, 0.14, 0.9, '#3aa04a').translateY(0.45).translateZ(0.15).rotateX(-0.5));
      at(0, 0.3, 1.7);
    } else if (id === 'phoenix') {
      g.add(box(0.5, 0.5, 0.8, '#e8842a').translateY(0.55).translateZ(0.3));
      g.add(box(0.14, 0.3, 0.14, '#ffcf4d').translateY(1.05).translateZ(0.2));
      g.add(box(0.8, 0.12, 0.5, '#ff6a2a').translateY(0.5).translateX(-0.45).translateZ(0.2).rotateY(0.5).rotateZ(-0.4));
      g.add(box(0.8, 0.12, 0.5, '#ff6a2a').translateY(0.5).translateX(0.45).translateZ(0.2).rotateY(-0.5).rotateZ(0.4));
      at(0, 0.3, 1.7);
    } else if (id === 'walrus') {
      g.add(box(0.6, 0.45, 0.7, '#c2a25a').translateY(0.5).translateZ(0.3));
      g.add(box(0.12, 0.3, 0.12, '#e8e8e8').translateY(0.5).translateX(-0.2).translateZ(0.7).rotateX(0.6));
      g.add(box(0.12, 0.3, 0.12, '#e8e8e8').translateY(0.5).translateX(0.2).translateZ(0.7).rotateX(0.6));
      at(0, 0.3, 1.7);
    } else if (id === 'shark') {
      g.add(box(0.5, 0.4, 1.1, '#5a6a7a').translateY(0.45).translateZ(0.3));
      g.add(box(0.5, 0.3, 0.5, '#6a7a8a').translateY(0.8).translateZ(0.6).rotateX(-0.7));
      g.add(box(0.3, 0.3, 0.3, '#c8302a').translateY(0.5).translateZ(0.9));
      at(0, 0.3, 1.75);
    } else if (id === 'kraken') {
      g.add(box(0.5, 0.6, 0.5, '#7a3ad8').translateY(0.55).translateZ(0.3));
      for (let i = 0; i < 4; i++) {
        g.add(box(0.14, 0.14, 0.8, '#8a4ae8').translateY(0.9).translateZ(0.2).rotateX(0.9).rotateY(i * Math.PI / 2 + 0.4));
      }
      at(0, 0.3, 1.7);
    } else if (id === 'capn') {
      g.add(box(0.5, 0.5, 0.5, '#e8b28a').translateY(0.55).translateZ(0.3));
      g.add(box(0.55, 0.2, 0.55, '#1a2a4a').translateY(0.9).translateZ(0.3));
      g.add(box(0.6, 0.5, 0.1, '#3a2a1a').translateY(0.55).translateZ(0.6).rotateY(0.15));
      at(0, 0.3, 1.7);
    }
    return g;
  }

  function buildCanoe(clsDef, cosmetics) {
    const paint = paintOf(cosmetics.paint);
    const L = 3.3 * clsDef.size;
    const Wd = 1.15 * clsDef.size; // narrow — real canoe proportions
    const g = new THREE.Group();
    const hull = new THREE.Group(); // pitch/roll inner
    g.add(hull);

    // keel
    const keel = box(0.4, 0.26, L * 0.85, '#2a2018');
    keel.position.y = -0.34;
    hull.add(keel);
    // main hull — long, narrow, low
    const main = box(Wd, 0.5, L, paint.color);
    main.position.y = -0.02;
    hull.add(main);
    // deck stripe
    const stripe = box(Wd + 0.02, 0.1, L * 0.72, paint.stripe);
    stripe.position.y = 0.15;
    hull.add(stripe);
    // BOW — long taper + the classic upturn
    const bow = box(Wd * 0.62, 0.4, 1.5, paint.color);
    bow.position.set(0, 0.1, L * 0.5 + 0.45);
    bow.rotation.x = -0.5;
    hull.add(bow);
    const bowTip = box(Wd * 0.34, 0.3, 0.6, paint.color);
    bowTip.position.set(0, 0.32, L * 0.5 + 1.15);
    bowTip.rotation.x = -0.85;
    hull.add(bowTip);
    // STERN — shorter taper with a small upturn
    const stern = box(Wd * 0.6, 0.36, 1.0, paint.color);
    stern.position.set(0, 0.1, -L * 0.5 - 0.25);
    stern.rotation.x = 0.55;
    hull.add(stern);
    // gunwales
    for (const sx of [-1, 1]) {
      const gl = box(0.12, 0.12, L * 0.92, '#3a2a20');
      gl.position.set(sx * (Wd / 2 + 0.05), 0.26, 0);
      hull.add(gl);
    }
    // thwart (cross brace) — canoe detail
    const thwart = box(Wd + 0.2, 0.1, 0.22, '#6b4a2e');
    thwart.position.set(0, 0.3, -L * 0.2);
    hull.add(thwart);
    // seat
    const seat = box(0.9, 0.16, 0.5, '#6b4a2e');
    seat.position.set(0, 0.38, L * 0.16);
    hull.add(seat);
    // ONE paddle resting across the gunwales at an angle — the canoe read
    // (never more than one: the motor/prop are gone, this is the paddler)
    const paddle = new THREE.Group();
    const shaft = box(0.1, 0.1, L * 0.6, '#c8a860');
    shaft.position.set(Wd * 0.75, 0.44, -0.35);
    shaft.rotation.z = 0.55;
    paddle.add(shaft);
    const blade = box(0.36, 0.07, 0.72, '#b8904a');
    blade.position.set(Wd * 0.75 + 0.28, 0.42, -0.72);
    blade.rotation.z = 0.55;
    blade.rotation.x = 0.14;
    paddle.add(blade);
    hull.add(paddle);
    // weapons
    const turret = new THREE.Group();
    turret.position.set(0, 0.35, L * 0.2);
    hull.add(turret);
    // figurehead — mounted on the BOW (front), classic placement
    const fh = figurehead(cosmetics.figurehead || 'none');
    if (fh.children.length) hull.add(fh);
    // flag — the DESIGN lives in the texture: base color + the icon picture
    // (anchor, jolly roger, blackbeard skull, kraken…) drawn over it
    const pole = box(0.1, 1.5, 0.1, '#7a6a3a');
    pole.position.set(0, 0.8, -L * 0.44);
    hull.add(pole);
    const fdef = flagDef(cosmetics.flag);
    const flagTex = canvasTex(64, 40, (ctx, w, h) => {
      ctx.fillStyle = fdef.color || '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
      ctx.font = '26px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fdef.icon || '▮', w / 2, h / 2 + 1);
    });
    const flagM = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshLambertMaterial({ map: flagTex, side: THREE.DoubleSide }));
    flagM.position.set(0.6, 1.2, -L * 0.44);
    hull.add(flagM);
    return { group: g, hull, turret, prop: null };
  }

  // ---------------- aim-line (own ship only) ----------------
  // Faint box trail tracing the predicted ballistic arc — reads as a
  // "spirit path" of wooden buoys, not a sci-fi laser, so it fits the art.
  const AIM_BOXES = 20;
  const aimBoxes = [];
  let aimGroup = null;
  function setAimPath(pts) {
    if (!aimGroup) {
      aimGroup = new THREE.Group();
      for (let i = 0; i < AIM_BOXES; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24),
          new THREE.MeshBasicMaterial({ color: '#cfeaff', transparent: true, opacity: 0 }));
        m.visible = false;
        aimGroup.add(m);
        aimBoxes.push(m);
      }
      scene.add(aimGroup);
    }
    const n = Math.min(pts.length, AIM_BOXES);
    // spread the boxes across the FULL arc (a long ballistic path has
    // more points than boxes — taking the first N left the trail
    // dangling mid-air for the barge's long shots)
    const step = Math.max(1, Math.floor(pts.length / AIM_BOXES));
    for (let i = 0; i < AIM_BOXES; i++) {
      const m = aimBoxes[i];
      if (i < n) {
        const p = pts[Math.min(pts.length - 1, i * step)];
        m.visible = true;
        m.position.set(p[0], p[1], p[2]);
        m.material.opacity = 0.2 + 0.55 * (1 - i / n); // strong near muzzle, fades toward impact
        m.scale.setScalar(Math.max(0.65, 1 - (i / n) * 0.35));
      } else {
        m.visible = false;
      }
    }
  }
  function clearAimPath() { if (aimGroup) for (const m of aimBoxes) m.visible = false; }

  // ---------------- public player visuals ----------------
  function upsertPlayer(id, pdata) {
    let pv = players.get(id);
    if (pv && pv.clsDef.id !== pdata.clsDef.id) {
      // the canoe class switched in the lobby — REBUILD the whole canoe so
      // the selected model (barge/rocket/razorfin) enters the scene
      scene.remove(pv.group);
      disposeGroup(pv.group);
      players.delete(id);
      pv = null;
    }
    if (!pv) {
      const built = buildCanoe(pdata.clsDef, pdata.cosmetics);
      scene.add(built.group);
      const label = nameSprite(pdata.name, '', '#ffffff');
      built.group.add(label);
      label.position.y = 2.5;
      const hp = hpSprite(1);
      built.group.add(hp);
      hp.position.y = 1.9;
      // shield aura — a translucent cyan shell that appears while shielded
      const aura = new THREE.Mesh(
        new THREE.BoxGeometry(1.15 * pdata.clsDef.size + 0.7, 1.2, 3.3 * pdata.clsDef.size + 0.7),
        new THREE.MeshLambertMaterial({ color: '#3fd8ff', transparent: true, opacity: 0.22, depthWrite: false })
      );
      aura.position.y = 0.05;
      aura.visible = false;
      built.hull.add(aura);
      pv = {
        id, group: built.group, hull: built.hull, turret: built.turret, prop: built.prop,
        label, hp, aura, tier: [-1, -1, -1], levels: [0, 0], lastHp: -1, hpBucket: -1, shBucket: -1, lastPos: new THREE.Vector3(),
        wakeT: 0, name: pdata.name, clsDef: pdata.clsDef, cosmetics: pdata.cosmetics,
        w1Mesh: null, w2Mesh: null, w2Fixed: pdata.clsDef.id === 'razorfin',
        plates: null, dmgGroup: null, dmgSig: '', dmgState: 0, smokeT: 0,
      };
      players.set(id, pv);
    }
    // cosmetics change (shouldn't happen mid-match, but safe)
    return pv;
  }

  function removePlayer(id) {
    const pv = players.get(id);
    if (pv) { scene.remove(pv.group); disposeGroup(pv.group); players.delete(id); }
  }

  // hull armor plating — grows with hull tier (physical trait upgrades look the part)
  function rebuildHullArmor(pv) {
    if (pv.plates) { pv.hull.remove(pv.plates); disposeGroup(pv.plates); }
    const plates = new THREE.Group();
    const ht = pv.tier[2];
    const Wd = 1.5 * pv.clsDef.size, L = 3.3 * pv.clsDef.size;
    if (ht >= 1) {
      for (const sx of [-1, 1]) {
        const pl = box(0.12, 0.16, L * 0.6, '#2e2e36');
        pl.position.set(sx * (Wd / 2 + 0.02), 0.3, 0);
        plates.add(pl);
      }
    }
    if (ht >= 2) {
      const bowP = box(Wd * 0.8, 0.18, 0.5, '#2e2e36');
      bowP.position.set(0, 0.32, L * 0.42);
      plates.add(bowP);
    }
    if (ht >= 3) {
      const strip = box(Wd + 0.1, 0.1, L * 0.72, '#4a4a54');
      strip.position.set(0, 0.42, 0);
      plates.add(strip);
    }
    if (ht >= 4) {
      const shell = box(Wd + 0.18, 0.2, L * 0.98, '#3a3a44');
      shell.position.set(0, 0.5, 0);
      plates.add(shell);
      const rivet = box(Wd + 0.24, 0.06, L * 0.5, '#5a5a66');
      rivet.position.set(0, 0.62, 0);
      plates.add(rivet);
    }
    pv.plates = plates;
    pv.hull.add(plates);
  }

  function rebuildWeapons(pv) {
    const cls = pv.clsDef.id;
    if (pv.w1Mesh) { pv.turret.remove(pv.w1Mesh); disposeGroup(pv.w1Mesh); }
    if (pv.w2Mesh) { (pv.w2Fixed ? pv.hull : pv.turret).remove(pv.w2Mesh); disposeGroup(pv.w2Mesh); }
    const L = 3.3 * pv.clsDef.size;
    pv.w1Mesh = buildWeapon(cls, 'w1', pv.tier[0], pv.levels[0]);
    pv.w1Mesh.position.set(0, 0.1, L * 0.3);
    pv.turret.add(pv.w1Mesh);
    pv.w2Mesh = buildWeapon(cls, 'w2', pv.tier[1], pv.levels[1]);
    if (pv.w2Fixed) {
      pv.w2Mesh.position.set(0, 0.28, -L * 0.34);
      pv.hull.add(pv.w2Mesh);
    } else {
      pv.w2Mesh.position.set(0, 0.08, -L * 0.24);
      pv.turret.add(pv.w2Mesh);
    }
    rebuildHullArmor(pv);
  }

  // incremental visual damage — scorch/dents where shots actually landed.
  // The marks lie FLAT against the deck (embedded, not floating slabs)
  function rebuildDamage(pv, spots, state) {
    if (pv.dmgGroup) { pv.hull.remove(pv.dmgGroup); disposeGroup(pv.dmgGroup); }
    const g = new THREE.Group();
    const L = 3.3 * pv.clsDef.size;
    const Wd = 1.15 * pv.clsDef.size; // hull WIDTH — spots must land on the
    // deck, never beside it: the generous hit radius lets a shot connect up
    // to ~1.9 u off-center, and the old length-based clamp (±0.45·L) allowed
    // that to render as a scorch floating in the water off the hull
    const cx = (v) => clamp(v, -Wd / 2 + 0.15, Wd / 2 - 0.15);
    const cz = (v) => clamp(v, -L * 0.42, L * 0.42);
    for (const sp of spots) {
      const sz = 0.55 + (sp.s || 0.4) * 0.7;
      const scorch = box(sz, 0.02, sz, '#14100c');
      scorch.position.set(cx(sp.x), 0.17, cz(sp.z));
      scorch.rotation.y = Math.random() * TAU;
      scorch.material.transparent = true;
      scorch.material.opacity = 0.85;
      g.add(scorch);
      if ((sp.s || 0) > 0.55) {
        const dent = box(sz * 0.5, 0.03, sz * 0.5, '#0a0806');
        dent.position.set(cx(sp.x), 0.16, cz(sp.z));
        dent.material.transparent = true;
        dent.material.opacity = 0.9;
        g.add(dent);
      }
    }
    if (state >= 1) {
      const crack = box(L * 0.5, 0.02, 0.14, '#0a0806');
      crack.position.set(Math.random() * L * 0.3 - L * 0.15, 0.2, Math.random() * L * 0.5 - L * 0.25);
      crack.rotation.y = Math.random() * TAU;
      crack.material.transparent = true;
      crack.material.opacity = 0.9;
      g.add(crack);
    }
    if (state >= 2) {
      const hole = box(0.5, 0.05, 0.5, '#0a0806');
      hole.position.set(L * 0.12, 0.17, -L * 0.1);
      hole.material.transparent = true;
      hole.material.opacity = 0.95;
      g.add(hole);
      const bent = box(L * 0.3, 0.08, 0.1, '#3a3a42');
      bent.position.set(-L * 0.25, 0.5, L * 0.15);
      bent.rotation.z = 0.5;
      g.add(bent);
    }
    if (state >= 3) {
      const plank = box(0.9, 0.06, 0.3, '#2a2018');
      plank.position.set(L * 0.05, 0.55, -L * 0.2);
      plank.rotation.x = 0.9; plank.rotation.y = 0.3;
      g.add(plank);
    }
    pv.dmgGroup = g;
    pv.hull.add(g);
  }

  // apply a per-frame player state (already interpolated by net layer)
  const _fwd = new THREE.Vector3();
  // SWELL-ONLY wave (the four low-frequency octaves, NO chop octave) — used
  // for the hull's visual tilt. Driving the tilt from the full waveH let the
  // chop octave (t·2.7, ~20 u wavelength) wobble the canoe AND the title
  // plate riding it: "the canoe shakes on the waves" — the hull now bobs
  // fluidly on the swell, with zero chop jitter. Visual-only (no server
  // mirror needed; the server never computes tilt).
  function swellH(x, z, t) {
    const w = Math.sin(x * 0.045 + t * 0.7) * 0.8
            + Math.sin(z * 0.055 + t * 0.85) * 0.65
            + Math.sin(x * 0.10 + t * 1.1) * 0.55
            + Math.sin(z * 0.08 + t * 0.9) * 0.45;
    return w * 1.125;
  }
  function applyPlayer(id, s, myId) {
    const pv = players.get(id);
    if (!pv) return;
    const { x, y, z, yaw, pitch, hp, maxHp, alive, boost, ty, tp } = s;
    pv.group.visible = alive;
    if (!alive) return;
    // server y already rides the swell exactly — only add wave-slope tilt
    const bob = waveH(x, z, time);
    pv.group.position.set(x, y + 0.35, z);
    pv.group.rotation.y = Math.PI / 2 - yaw;
    // smooth pitch/roll
    const speed = Math.hypot(s.vx || 0, s.vz || 0);
    const accel = Math.abs(speed - (pv.lastSpeed || 0));
    pv.lastSpeed = speed;
    // bob = swell-only height (no chop) so the hull pitch never jitters
    const bobS = swellH(x, z, time);
    const targetPitch = clamp((bobS * 0.12) + (boost > 0 ? 0.14 : 0) - (accel > 8 ? 0.1 : 0), -0.35, 0.45);
    const targetRoll = clamp(-(s.turn || 0) * 0.12 + bobS * 0.08, -0.3, 0.3);
    pv.hull.rotation.x += (targetPitch - pv.hull.rotation.x) * Math.min(1, 0.18);
    pv.hull.rotation.z += (targetRoll - pv.hull.rotation.z) * Math.min(1, 0.18);
    // turret — the turret is a CHILD of the hull (which rotates π/2 - yaw),
    // so its own yaw must COMPENSATE: total world rotation = (π/2 - yaw) +
    // (yaw - ty) = π/2 - ty → barrel points exactly along the aim line.
    // PITCH: three.js Euler 'XYZ' maps local +Z to world-Y = -sin(x)·cos(y),
    // so the visual pitch is the NEGATED aim pitch.
    pv.turret.rotation.y = yaw - ty;
    pv.turret.rotation.x = -tp;
    // prop spin
    if (pv.prop) pv.prop.rotation.y += speed * 0.4;
    // weapons tier + KILL-UPGRADE levels (u1/u2) — both rebuild the visuals
    if (s.w && (s.w[0] !== pv.tier[0] || s.w[1] !== pv.tier[1])) {
      pv.tier = [s.w[0], s.w[1], s.w[2]];
      rebuildWeapons(pv);
    } else if (s.w && s.w[2] !== pv.tier[2]) {
      pv.tier[2] = s.w[2];
      rebuildHullArmor(pv);
    }
    if ((s.u1 || 0) !== pv.levels[0] || (s.u2 || 0) !== pv.levels[1]) {
      pv.levels = [(s.u1 || 0), (s.u2 || 0)];
      rebuildWeapons(pv);
    }
    // visual damage: spots where shots landed + progressive wreck state
    const ds = s.ds || [];
    const dSig = ds.length ? ds.map(d => d.x + ',' + d.z + ',' + d.s).join('|') : '';
    const frac = hp / maxHp;
    const dState = frac < 0.25 ? 3 : frac < 0.5 ? 2 : frac < 0.75 ? 1 : 0;
    if (dSig !== pv.dmgSig || dState !== pv.dmgState) {
      pv.dmgSig = dSig;
      pv.dmgState = dState;
      rebuildDamage(pv, ds, dState);
    }
    // hp bar — standard health + shield layer (cyan segment, absorbs first)
    const shFrac = (s.sh || 0) / SHIELD_MAX;
    const bucket = clamp(Math.round((hp / maxHp) * 20), 0, 20);
    const shBucket = clamp(Math.round(shFrac * 20), 0, 20);
    if (bucket !== pv.hpBucket || shBucket !== pv.shBucket) {
      pv.hpBucket = bucket;
      pv.shBucket = shBucket;
      const spr = hpSprite(hp / maxHp, shFrac);
      pv.hp.material = spr.material;
      pv.hp.material.map = spr.material.map;
    }
    // shield aura shell — visible only while shielded
    if (pv.aura) {
      pv.aura.visible = (s.sh || 0) > 0;
      pv.aura.material.opacity = 0.16 + 0.1 * Math.sin(time * 3.4);
    }
    // buoyant tilt on the analytic SWELL (visual-only, chop-free: the full
    // waveH slope wobbled the hull + nameplate — "remove the shake"). The
    // slow 0.12 ease rides the long swell fluidly; the hull itself just bobs.
    const gx = pv.group.position.x, gz = pv.group.position.z;
    pv.group.rotation.x += ((swellH(gx, gz + 0.8, time) - swellH(gx, gz - 0.8, time)) * 0.9 - pv.group.rotation.x) * 0.12;
    pv.group.rotation.z += ((swellH(gx - 0.8, gz, time) - swellH(gx + 0.8, gz, time)) * 0.9 - pv.group.rotation.z) * 0.12;
    // wake — scheduled on the wall-clock scene time (NOT per-frame counting:
    // the old `wakeT -= 1/60` ran at 60-fps assumption, so slow frames cut the
    // trail spawn rate to almost nothing and the icon stream vanished)
    if (speed > 3.5 && time >= (pv.nextWakeAt || 0)) {
      pv.nextWakeAt = time + 0.13;
      const td = trailDef(pv.cosmetics.trail);
      spawnWake(pv.group.position, yaw, speed, boost > 0, td ? td.color : null);
      // the fun jet stream: a shower of tiny ICON PIXELS (stars, flames,
      // poison, dookie, ice…) instead of water — hundreds of them behind
      // the hull; they sink into the ocean and fade (pure vfx, not assets)
      if (td && td.icon && speed > 3) spawnTrailIcons(pv.group.position, yaw, td.icon, boost > 0);
    }
  }

  // ---- trail icon pixels: pooled emoji sprites, sink + fade ----
  const trailIconPool = [];
  const trailIcons = [];
  const trailTexCache = new Map(); // icon -> CanvasTexture (shared)
  function trailIconTexture(icon) {
    let tex = trailTexCache.get(icon);
    if (!tex) {
      tex = canvasTex(64, 64, (ctx, w, h) => {
        ctx.font = '44px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, w / 2, h / 2 + 2);
      });
      trailTexCache.set(icon, tex);
    }
    return tex;
  }
  function spawnTrailIcons(pos, yaw, icon, boosting) {
    const n = boosting ? 7 : 5;
    for (let i = 0; i < n; i++) {
      if (trailIcons.length > 220) return; // hard budget: drop rather than stall
      let sp = trailIconPool.pop();
      if (!sp) {
        sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: trailIconTexture(icon), transparent: true, depthWrite: false }));
        scene.add(sp);
      } else {
        sp.material.map = trailIconTexture(icon);
      }
      sp.material.opacity = 0.95;
      sp.visible = true;
      const back = 1.7 + Math.random() * 1.6;
      const side = (Math.random() - 0.5) * 1.5;
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      sp.position.set(
        pos.x - cy * back + sy * side,
        0.22 + Math.random() * 0.25,
        pos.z - sy * back - cy * side,
      );
      const s = 0.16 + Math.random() * 0.13;
      sp.scale.set(s, s, 1);
      const life = 1.8 + Math.random() * 0.9;
      trailIcons.push({
        sp,
        vx: -cy * (1.2 + Math.random() * 1.4) + sy * (Math.random() - 0.5),
        vz: -sy * (1.2 + Math.random() * 1.4) - cy * (Math.random() - 0.5),
        vy: 0.1 + Math.random() * 0.3, // brief hop, then they SINK
        ttl: life, life,
        spin: Math.random() * TAU,
      });
    }
  }

  function spawnWake(pos, yaw, speed, boosting, trailCol) {
    for (const side of [-1, 1]) {
      const bx = pos.x - Math.cos(yaw) * 1.7 + Math.sin(yaw) * side * 0.8;
      const bz = pos.z - Math.sin(yaw) * 1.7 - Math.cos(yaw) * side * 0.8;
      const col = boosting && trailCol ? trailCol : '#e8f4ff';
      const p = spawnParticle(new THREE.Vector3(bx, 0.12, bz),
        boosting ? 0.5 : 0.34, col, false,
        new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.6, (Math.random() - 0.5) * 1.5),
        1.1, -1.5, true);
      if (p) p.mesh.material.transparent = true;
    }
  }

  // ---------------- particles / effects ----------------
  // Pooled particle meshes — no per-spawn alloc/dealloc (GC spikes were the
  // source of sudden lag). Shared geometry, one material per mesh, hard budget.
  const PART_GEO = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const partPool = [];
  function spawnParticle(pos, size, color, emissive, vel, life, grav = -4, sink = false) {
    let m = partPool.pop();
    if (!m) {
      if (particles.length > 150) return null; // budget: drop rather than stall
      m = new THREE.Mesh(PART_GEO, new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#000000', transparent: true }));
    }
    m.visible = true;
    m.material.color.set(color);
    m.material.emissive.set(emissive ? color : '#000000');
    m.material.opacity = 0.85;
    m.position.copy(pos);
    m.rotation.set(Math.random() * TAU, Math.random() * TAU, 0);
    m.scale.setScalar(size / 0.5);
    scene.add(m);
    const p = { mesh: m, vel, ttl: life, life, grav, sink, base: size, scale: size / 0.5 };
    particles.push(p);
    return p;
  }

  // ---- shared fx resources (bullet-storm hardening) ----
  // Every splash/boom/muzzle used to create a fresh BoxGeometry PER EVENT —
  // a new GPU attribute upload each time. During a heavy exchange (dozens of
  // shells in flight, several hits/sec) that churned uploads + GC hitches on
  // ANY machine. Geometries are SHAREABLE (unlike meshes — the Object3D
  // reparent rule): all fx draw from two unit geometries, scaled per
  // instance. The fx-expiry path must NOT dispose them (shared, live forever).
  const FX_UNIT_GEO = new THREE.BoxGeometry(1, 1, 1);
  const FX_RING_GEO = new THREE.BoxGeometry(1, 0.12, 1);
  // explosion lights: each boom added its own PointLight; enough concurrent
  // booms crossed three.js's light-count recompile thresholds (0/1/2/4/8…)
  // = shader recompile hitches mid-fight. Cap the concurrent count.
  let boomLightCount = 0;
  const BOOM_LIGHT_MAX = 3;
  // canoe wake foam (AA fidelity): pooled flat white patches trailing each
  // hull — the wakes array was declared for years and never used. Trail
  // cosmetics tint the foam (TRAIL_COLORS above mirrors profile.js TRAILS).
  const wakePool = [];
  function wakeSpawn(x, z, col) {
    let m = wakePool.pop();
    if (!m) {
      if (wakes.length > 60) return; // hard budget: drop rather than stall
      m = new THREE.Mesh(FX_RING_GEO, new THREE.MeshBasicMaterial({ color: '#dff4ff', transparent: true, depthWrite: false }));
    }
    const tdc = trailDef(col);
    m.material.color.set((tdc && tdc.color) || '#dff4ff');
    m.visible = true;
    m.position.set(x, 0.02, z);
    m.rotation.y = Math.random() * TAU;
    m.scale.set(0.3 + Math.random() * 0.4, 0.1, 0.3 + Math.random() * 0.4);
    m.material.opacity = 0.55;
    scene.add(m);
    wakes.push({ mesh: m, ttl: 1.1, life: 1.1 });
  }

  function boom(x, y, z, size, big) {
    const s = clamp(size || 4, 2, 12);
    // flash
    const flash = new THREE.Mesh(FX_UNIT_GEO,
      new THREE.MeshBasicMaterial({ color: '#ffcf7a', transparent: true }));
    flash.position.set(x, y + 0.5, z);
    scene.add(flash);
    fx.push({ type: 'flash', mesh: flash, ttl: 0.16, life: 0.16, target: s * (big ? 2 : 1.4) });
    // ring on water
    const ring = new THREE.Mesh(FX_RING_GEO,
      new THREE.MeshBasicMaterial({ color: '#cfefff', transparent: true, opacity: 0.85 }));
    ring.position.set(x, 0.06, z);
    scene.add(ring);
    fx.push({ type: 'ring', mesh: ring, ttl: 0.5, life: 0.5, target: s * 1.7 });
    // debris + fire
    const n = Math.round(4 + s * 1.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, up = Math.random() * 1 + 2;
      spawnParticle(new THREE.Vector3(x, y + 0.3, z), 0.2 + Math.random() * 0.3,
        ['#3a2a1a', '#5a3a22', '#7a4a28'][i % 3], false,
        new THREE.Vector3(Math.cos(a) * (3 + Math.random() * 6), up, Math.sin(a) * (3 + Math.random() * 6)),
        0.8 + Math.random() * 0.5, -9);
    }
    for (let i = 0; i < Math.round(n * 0.6); i++) {
      const a = Math.random() * TAU;
      spawnParticle(new THREE.Vector3(x, y + 0.4, z), 0.3 + Math.random() * 0.3,
        ['#ff9d3c', '#ff6a2a', '#ffcf4d'][i % 3], true,
        new THREE.Vector3(Math.cos(a) * 2, 3 + Math.random() * 4, Math.sin(a) * 2),
        0.35 + Math.random() * 0.25, -3);
    }
    // light flash — capped pool: extra booms skip the light instead of
    // stacking PointLights (shader recompile hitches at light-count thresholds)
    if (boomLightCount < BOOM_LIGHT_MAX) {
      boomLightCount++;
      const pl = new THREE.PointLight('#ffb347', 60, 80);
      pl.position.set(x, y + 1, z);
      scene.add(pl);
      fx.push({ type: 'light', light: pl, ttl: 0.32, life: 0.32 });
    }
  }

  function splash(x, z, size) {
    const n = Math.round(6 + (size || 0) * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      spawnParticle(new THREE.Vector3(x, 0.15, z), 0.22 + Math.random() * 0.18, '#e8f4ff', false,
        new THREE.Vector3(Math.cos(a) * (1.5 + Math.random() * 3), 2.5 + Math.random() * 3, Math.sin(a) * (1.5 + Math.random() * 3)),
        0.6 + Math.random() * 0.3, -8);
    }
    const ring = new THREE.Mesh(FX_RING_GEO,
      new THREE.MeshBasicMaterial({ color: '#e8f4ff', transparent: true, opacity: 0.7 }));
    ring.position.set(x, 0.05, z);
    scene.add(ring);
    fx.push({ type: 'ring', mesh: ring, ttl: 0.4, life: 0.4, target: 2.5 + (size || 0) * 0.5 });
  }

  function muzzle(x, y, z, yaw, pitch, cls) {
    const m = new THREE.Mesh(FX_UNIT_GEO,
      new THREE.MeshBasicMaterial({ color: '#ffdf8a', transparent: true }));
    m.scale.set(0.5, 0.5, 1.2); // shared unit geometry, scaled per instance
    // AA punch: a brief muzzle light (shares the capped light pool)
    if (boomLightCount < BOOM_LIGHT_MAX) {
      boomLightCount++;
      const ml = new THREE.PointLight('#ffd9a0', 26, 22);
      ml.position.set(x, y, z);
      scene.add(ml);
      fx.push({ type: 'light', light: ml, ttl: 0.07, life: 0.07 });
    }
    m.position.set(x, y, z);
    const c = Math.cos(pitch);
    m.rotation.y = Math.PI / 2 - yaw;
    m.rotation.x = pitch;
    m.translateZ(0.8);
    scene.add(m);
    fx.push({ type: 'muzzle', mesh: m, ttl: 0.09, life: 0.09 });
  }

  function dmgNumber(x, y, z, text, color) {
    const sp = dmgSprite(text, color);
    sp.position.set(x, y + 0.3, z);
    scene.add(sp);
    fx.push({ type: 'dmg', mesh: sp, ttl: 0.85, life: 0.85 });
  }

  function pickupFx(x, y, z, kind) {
    const col = { heal: '#3fd96b', credits: '#ffd23f', overclock: '#ff4fd8', upgrade: '#7fe8ff' }[kind] || '#fff';
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      spawnParticle(new THREE.Vector3(x, y, z), 0.18, col, true,
        new THREE.Vector3(Math.cos(a) * 2.5, 2.5 + Math.random() * 2, Math.sin(a) * 2.5),
        0.5, -4);
    }
  }

  function handleFx(f) {
    switch (f.f) {
      case 'boom': boom(f.x, f.y, f.z, f.s, f.big); break;
      case 'cannonWarn': {
        // CANNON COVE telegraph: pulsing red ring + beacon at the aim point
        const ring = new THREE.Mesh(FX_RING_GEO,
          new THREE.MeshBasicMaterial({ color: '#ff5e4d', transparent: true, opacity: 0.8, depthWrite: false }));
        ring.position.set(f.x, 0.35, f.z);
        ring.rotation.x = -Math.PI / 2;
        scene.add(ring);
        const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.55, 4.5, 8, 1, true),
          new THREE.MeshBasicMaterial({ color: '#ff5e4d', transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
        beacon.position.set(f.x, 2.25, f.z);
        scene.add(beacon);
        warnFx.push({ ring, beacon, ttl: 1.4, life: 1.4 });
        break;
      }
      case 'cannonFire': {
        // muzzle smoke at the battery + barrel recoil on the fortress model
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU;
          spawnParticle(new THREE.Vector3(f.x, f.y, f.z), 0.3 + Math.random() * 0.25, '#8a8a94', false,
            new THREE.Vector3(Math.cos(a) * 3, 1.5 + Math.random() * 2, Math.sin(a) * 3),
            0.5, -2);
        }
        const m = new THREE.Mesh(FX_UNIT_GEO,
          new THREE.MeshBasicMaterial({ color: '#ffdf8a', transparent: true }));
        m.scale.set(0.9, 0.9, 0.9);
        m.position.set(f.x, f.y, f.z);
        scene.add(m);
        fx.push({ type: 'flash', mesh: m, ttl: 0.14, life: 0.14, target: 0.9 });
        if (arenaGroup && arenaGroup.userData.cannons && arenaGroup.userData.cannons[f.cn]) {
          const bat = arenaGroup.userData.cannons[f.cn];
          bat.userData.recoil = 1;
        }
        break;
      }
      case 'blast': {
        // the barge's THUNDER SHOTGUN — a VISIBLE downward spray: white foam
        // particles in a cone sweeping DOWN into the waterline. The pellets
        // are too small/fast to read as "angled down" from the chase camera,
        // so the blast itself carries the angle.
        const a = f.a || 0;
        for (let i = 0; i < 14; i++) {
          const spread = (Math.random() - 0.5) * 0.5;  // yaw cone ±14°
          const down = 0.10 + Math.random() * 0.20;    // pitch 6°–17° down (raised again — the cone brackets the −6.9° pellets)
          const spd = 8 + Math.random() * 10;
          const ca = Math.cos(a + spread), sa = Math.sin(a + spread);
          spawnParticle(new THREE.Vector3(f.x, f.y, f.z), 0.22, '#e8f4ff', true,
            new THREE.Vector3(ca * spd, -Math.sin(down) * spd, sa * spd),
            0.4, -6);
        }
        break;
      }
      case 'splash': splash(f.x, f.z, f.s); break;
      case 'land': splash(f.x, f.z, f.s * 0.5); boom(f.x, f.y, f.z, 2.5, 0); break;
      case 'muzzle': muzzle(f.x, f.y, f.z, f.a, f.p || 0, f.c); break;
      case 'hit': dmgNumber(f.x, f.y, f.z, String(f.d), f.v === myIdRef.current ? '#ff5e4d' : '#ffd23f'); break;
      case 'pickup': pickupFx(f.x, f.y, f.z, f.k); if (f.d > 0) dmgNumber(f.x, f.y + 0.8, f.z, f.k === 'heal' ? '+' + f.d : '+' + f.d + '💰', f.k === 'heal' ? '#3fe08a' : '#ffd23f'); break;
      case 'boost': {
        const a = f.a || 0;
        for (let i = 0; i < 6; i++) {
          spawnParticle(new THREE.Vector3(f.x, f.y, f.z), 0.3, '#ffffff', false,
            new THREE.Vector3(-Math.cos(a) * (2 + Math.random() * 3), 1 + Math.random(), -Math.sin(a) * (2 + Math.random() * 3)),
            0.5, -2);
        }
        break;
      }
      case 'launch': splash(f.x, f.z, 1.5); break;
      case 'hop': // water burst under a jump
        for (let i = 0; i < 7; i++) {
          spawnParticle(new THREE.Vector3(f.x + (Math.random() - 0.5) * 1.4, f.y, f.z + (Math.random() - 0.5) * 1.4),
            0.25, '#dff4ff', false,
            new THREE.Vector3((Math.random() - 0.5) * 2.4, 1.5 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4),
            0.5, -2.5);
        }
        break;
      case 'ram': boom(f.x, f.y, f.z, 2.2, 0); break;
      case 'ability': {
        if (f.c === 'razorfin') {
          for (let i = 0; i < 8; i++) {
            spawnParticle(new THREE.Vector3(f.x, f.y, f.z), 0.25, '#7fdcff', true,
              new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 2, (Math.random() - 0.5) * 8), 0.4, -1);
          }
        } else if (f.c === 'barge') {
          boom(f.x, f.y, f.z, 2, 0);
        } else {
          for (let i = 0; i < 10; i++) {
            spawnParticle(new THREE.Vector3(f.x, f.y, f.z), 0.3, '#ff9d3c', true,
              new THREE.Vector3((Math.random() - 0.5) * 3, 4 + Math.random() * 3, (Math.random() - 0.5) * 3), 0.6, -6);
          }
        }
        break;
      }
      case 'buy': pickupFx(f.x, f.y, f.z, 'credits'); break;
      case 'join': splash(f.x, f.z, 1); break;
      case 'horn': break;
    }
  }
  const myIdRef = { current: -1 };

  // ---------------- projectiles ----------------
  const PROJ_COLORS = {
    rail: '#6ff3ff', cannon: '#3a2a22', mortar: '#2a2018', rocket: '#c8552a',
    shot: '#8a8a94', mine: '#22252a', torp: '#4a5a6a', bomblet: '#555a60', harpoon: '#e8e8e8',
  };
  const PROJ_SIZE = {
    rail: [0.16, 0.16, 1.5], cannon: [0.55, 0.55, 0.55], mortar: [0.8, 0.8, 0.8],
    rocket: [0.32, 0.32, 0.9], shot: [0.26, 0.26, 0.26], mine: [0.7, 0.5, 0.7],
    torp: [0.32, 0.32, 1.3], bomblet: [0.3, 0.3, 0.3], harpoon: [0.14, 0.14, 1.7],
  };
  const PROJ_EMIT = { rail: true, rocket: true };

  // THE shared projectile visual builder — the in-game meshes AND the lobby
  // preview clips both build from this, so what the preview shows is what
  // flies in the match (user: "make sure the assets in the video preview
  // match the actual assets used in gameplay").
  function buildProjVisual(kind) {
    if (kind === 'mine') {
      // mine: dark spiky ball with a pulsing red core — reads as a mine
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.85), new THREE.MeshLambertMaterial({ color: '#33333a', emissive: '#101014' })));
      for (let i = 0; i < 6; i++) {
        const phi = (i / 6) * TAU;
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.55), new THREE.MeshLambertMaterial({ color: '#26262c' }));
        sp.position.set(Math.cos(phi) * 0.62, 0, Math.sin(phi) * 0.62);
        sp.rotation.y = Math.PI / 2 - phi;
        g.add(sp);
      }
      for (const sy of [-1, 1]) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), new THREE.MeshLambertMaterial({ color: '#26262c' }));
        sp.position.set(0, sy * 0.62, 0);
        g.add(sp);
      }
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: '#ff3030' }));
      core.position.y = 0.65;
      g.add(core);
      // health bar: shoot mines to clear them before running over them
      const barBg = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.14, 0.1), new THREE.MeshBasicMaterial({ color: '#3a1a1a' }));
      barBg.position.y = 1.45;
      g.add(barBg);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.1, 0.06), new THREE.MeshBasicMaterial({ color: '#7dff4d' }));
      bar.position.y = 1.45;
      g.add(bar);
      g.userData.hpBar = bar;
      g.userData.core = core;
      return g;
    }
    const [w, h, d] = PROJ_SIZE[kind] || [0.4, 0.4, 0.4];
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: PROJ_COLORS[kind] || '#fff', emissive: PROJ_EMIT[kind] ? PROJ_COLORS[kind] : '#000000' }));
    if (kind === 'rocket') {
      const flame = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.45),
        new THREE.MeshBasicMaterial({ color: '#ff9d3c' }));
      flame.position.z = -0.55;
      m.add(flame);
    }
    return m;
  }

  function projMesh(kind) {
    let pool = projPool.get(kind);
    if (!pool) { pool = []; projPool.set(kind, pool); }
    let m = pool.pop();
    if (!m) {
      m = buildProjVisual(kind);
      m.userData.spin = Math.random() * TAU;
      m.userData.kind = kind;
      scene.add(m);
    }
    m.visible = true;
    return m;
  }

  const _dir = new THREE.Vector3();
  const _zAxis = new THREE.Vector3(0, 0, 1); // bullet-storm hardening: the
  // per-shell setFromUnitVectors used to allocate a fresh Vector3 PER SHELL
  // PER FRAME — dozens of shells = dozens of allocs/frame = GC hitches in
  // heavy exchanges on any machine.
  function syncProjectiles(list) {
    const used = new Set();
    for (const q of list) {
      let m = projLive.get(q.i);
      if (!m) {
        m = projMesh(q.k);
        projLive.set(q.i, m);
      }
      used.add(q.i);
      const c = Math.cos(q.p);
      _dir.set(Math.cos(q.a) * c, Math.sin(q.p), Math.sin(q.a) * c);
      if (q.k === 'mine') _dir.set(0, 1, 0);
      m.position.set(q.x, q.y, q.z);
      m.quaternion.setFromUnitVectors(_zAxis, _dir.normalize());
      // projectile size matches the barrel that fired it (tier + upgrade level)
      const bs = 1 + (q.tn || 0) * 0.14 + (q.lv || 0) * 0.16;
      m.scale.set(bs, bs, bs);
      if (q.k === 'mine' && m.userData.core) {
        // pulse the mine's warning light
        m.userData.core.scale.setScalar(0.7 + 0.5 * Math.sin(time * 7 + q.i));
        // shrink the health bar as the mine takes damage
        if (m.userData.hpBar) {
          const f = Math.max(0, Math.min(1, (q.h || 0) / (q.hm || 30)));
          m.userData.hpBar.scale.x = Math.max(0.05, f);
          m.userData.hpBar.position.x = -(1 - f) * 0.47;
        }
      }
      m.userData.spin += 0.1;
      if (q.k === 'cannon' || q.k === 'mortar' || q.k === 'shot' || q.k === 'bomblet') {
        // roll around the LONG axis (Z = flight direction after the quaternion).
        // The old Y-spin tumbled the box so its long axis swung away from the
        // flight path — the pellets' true pitch was invisible ("hard to tell
        // if it's firing downwards" — it was, but the render hid the angle).
        m.rotateZ(m.userData.spin);
      }
    }
    for (const [id, m] of projLive) {
      if (!used.has(id)) { m.visible = false; projPool.get(m.userData.kind || 'shot')?.push(m); projLive.delete(id); }
    }
  }

  // ---------------- ramp-top weapon-upgrade pickup ----------------
  // a floating golden gem above one of the boost ramps — reachable only
  // by riding the ramp and jumping (the server enforces the 3D grab)
  let upgradeMesh = null, upgradeBeam = null;
  function syncUpgradePickup(up) {
    if (!upgradeMesh) {
      upgradeMesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.8, 0),
        new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 1 }));
      scene.add(upgradeMesh);
      // a tall light beacon from the water up to the gem — the pickup
      // reads from across the map (and doubles as the "aim here" hint)
      upgradeBeam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.5, 4.4, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
      upgradeBeam.position.y = 2.2;
      upgradeMesh.add(upgradeBeam);
    }
    upgradeMesh.visible = !!(up && up.a === 1);
    if (up && up.a === 1) {
      upgradeMesh.position.set(up.x, up.y + 0.35 + Math.sin(time * 2.2) * 0.18, up.z);
      upgradeMesh.rotation.y += 0.035;
      upgradeMesh.rotation.x = Math.sin(time * 1.3) * 0.25;
      upgradeBeam.material.opacity = 0.18 + Math.sin(time * 3.4) * 0.07; // pulse
    }
  }

  // ---------------- shield pickups ----------------
  const pickupMeshes = new Map();
  function pickupMesh() {
    const g = new THREE.Group();
    // floating shield icon: cyan slab + white chevron + glow ring
    const shield = box(1.4, 1.6, 0.35, '#2fb8e8', { emissive: '#0a5a8a' });
    g.add(shield);
    const chev = box(0.9, 0.3, 0.4, '#e8fbff', { emissive: '#9fe8ff' });
    chev.position.y = 0.2;
    g.add(chev);
    const ring = box(1.9, 0.14, 0.14, '#7fe0ff', { emissive: '#7fe0ff' });
    ring.position.y = 1.05;
    g.add(ring);
    return g;
  }
  function syncPickups(list) {
    const used = new Set();
    for (const pk of list || []) {
      const key = pk.x + ',' + pk.z;
      let g = pickupMeshes.get(key);
      if (!g) { g = pickupMesh(); scene.add(g); pickupMeshes.set(key, g); }
      used.add(key);
      g.position.set(pk.x, 1.15 + Math.sin(time * 2.6 + pk.x * 0.3) * 0.22, pk.z);
      g.rotation.y += 0.04;
      g.visible = pk.a === 1;
    }
    for (const [key, g] of pickupMeshes) {
      if (!used.has(key)) { scene.remove(g); disposeGroup(g); pickupMeshes.delete(key); }
    }
  }

  // ---------------- crates ----------------
  function crateMesh(kind) {
    const g = new THREE.Group();
    const cfg = {
      heal: { col: '#3fd96b', em: '#2fbf5b', icon: 'cross' },
      credits: { col: '#ffd23f', em: '#e0b020', icon: 'coins' },
      overclock: { col: '#ff4fd8', em: '#e030b8', icon: 'bolt' },
    }[kind] || { col: '#ffffff', em: '#cccccc', icon: 'cross' };
    const main = box(1.5, 1.5, 1.5, cfg.col, { emissive: cfg.em });
    g.add(main);
    // chunky glowing icon on top — readable across the whole arena
    if (cfg.icon === 'cross') {
      g.add(box(1.2, 0.34, 0.34, '#ffffff', { emissive: '#ffffff' }).translateY(0.95));
      g.add(box(0.34, 1.2, 0.34, '#ffffff', { emissive: '#ffffff' }).translateY(0.95));
    } else if (cfg.icon === 'coins') {
      for (let i = 0; i < 3; i++) {
        g.add(box(0.8, 0.24, 0.8, '#fff3b0', { emissive: '#ffe98a' }).translateY(1.05 + i * 0.28).rotateX(Math.PI / 2));
      }
    } else {
      g.add(box(0.32, 1.3, 0.32, '#ffffff', { emissive: '#ffffff' }).translateY(1.0).rotateZ(0.6));
      g.add(box(0.32, 1.3, 0.32, '#ffffff', { emissive: '#ffffff' }).translateY(1.0).rotateZ(-0.6));
    }
    return g;
  }

  function syncCrates(list) {
    const used = new Set();
    for (const c of list) {
      let g = crateMeshes.get(c.i);
      if (!g) { g = crateMesh(c.k); scene.add(g); crateMeshes.set(c.i, g); }
      used.add(c.i);
      g.position.set(c.x, 0.8 + Math.sin(time * 2.4 + c.i) * 0.18, c.z);
      g.rotation.y += 0.03;
    }
    for (const [id, g] of crateMeshes) {
      if (!used.has(id)) { scene.remove(g); disposeGroup(g); crateMeshes.delete(id); }
    }
  }

  // ---------------- aim markers (WoWS-style impact + lead) ----------------
  // Yellow X on the water at the predicted shell impact; red X at the predicted
  // intercept of the nearest enemy near the crosshair (shell flight-time lead).
  const aimMarkGroup = new THREE.Group();
  const markMat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
  const mkImpact = new THREE.Group();
  const mkLead = new THREE.Group();
  function buildX(g, color, size) {
    const m = markMat(color);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(size, 0.1, 0.16), m));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, size), m));
  }
  buildX(mkImpact, '#ffd23f', 1.4);
  buildX(mkLead, '#ff5a3c', 1.5);
  mkImpact.visible = false; mkLead.visible = false;
  aimMarkGroup.add(mkImpact, mkLead);
  scene.add(aimMarkGroup);
  function setAimMarkers(impact, lead) {
    if (impact) { mkImpact.position.set(impact.x, 0.25, impact.z); mkImpact.visible = true; }
    else mkImpact.visible = false;
    if (lead) { mkLead.position.set(lead.x, 0.25, lead.z); mkLead.visible = true; }
    else mkLead.visible = false;
    // bob gently on the swell
    if (impact) mkImpact.position.y = 0.22 + Math.abs(Math.sin(time * 2.2)) * 0.14;
    if (lead) mkLead.position.y = 0.22 + Math.abs(Math.sin(time * 2.2 + 1)) * 0.14;
  }

  // ---------------- KOTH zone marker ----------------
  let zoneGroup = null;
  function setZone(z) {
    if (zoneGroup) { scene.remove(zoneGroup); disposeGroup(zoneGroup); zoneGroup = null; }
    if (!z) return;
    zoneGroup = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.16, depthWrite: false });
    const R = z.r;
    for (let i = 0; i < 16; i++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, R * 0.24), ringMat);
      const a = (i / 16) * TAU;
      seg.position.set(z.x + Math.cos(a) * R, 0.18, z.z + Math.sin(a) * R);
      seg.rotation.y = -a;
      zoneGroup.add(seg);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const pole = box(0.4, 5, 0.4, '#4a4a54');
      pole.position.set(z.x + Math.cos(a) * R, 2.5, z.z + Math.sin(a) * R);
      zoneGroup.add(pole);
      const light = box(0.8, 0.8, 0.8, '#ffd23f', { emissive: '#ffd23f' });
      light.position.set(z.x + Math.cos(a) * R, 5.5, z.z + Math.sin(a) * R);
      light.userData.beacon = true;
      zoneGroup.add(light);
    }
    scene.add(zoneGroup);
  }

  // ---------------- canoe card image (lobby selection) ----------------
  // one shared card renderer (never one renderer per card — context-fragile)
  let cardRenderer = null;
  function canoeImage(clsDef, tier = 0) {
    const sc = new THREE.Scene();
    sc.background = new THREE.Color('#0a2a48');
    const cam = new THREE.PerspectiveCamera(38, 220 / 138, 0.1, 60);
    cam.position.set(5.6, 2.8, 6.4);
    cam.lookAt(0, 0.4, 0);
    sc.add(new THREE.HemisphereLight('#bfe8ff', '#123a5e', 1.1));
    const dl = new THREE.DirectionalLight('#fff2d0', 1.5);
    dl.position.set(4, 7, 3);
    sc.add(dl);
    // real hull + real weapon on the turret, like the in-game canoe
    const built = buildCanoe(clsDef, { paint: clsDef.paint || '#e8573d' });
    const L = 3.3 * clsDef.size;
    const turret = new THREE.Group();
    turret.position.set(0, 0.35, L * 0.2);
    turret.add(buildWeapon(clsDef.id, 'w1', tier));
    built.hull.add(turret);
    built.group.rotation.y = Math.PI / 4.5;
    sc.add(built.group);
    if (!cardRenderer) {
      cardRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      cardRenderer.setPixelRatio(1);
    }
    cardRenderer.setSize(220, 138, false);
    cardRenderer.render(sc, cam);
    return cardRenderer.domElement.toDataURL();
  }

  // ---------------- hover preview CLIP: canoe fires its gun on a loop ----------------
  const clipCache = new Map();
  let previewRenderer = null; // bound to the popup's OWN canvas — the clip
  // renders INTO #previewCv (the old code drew to the renderer's private
  // canvas and the popup stayed blank — "preview video is not working")
  function classClipFrame(clsDef, t, canvas) {
    let s = clipCache.get(clsDef.id);
    if (!s) {
      s = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(34, 360 / 230, 0.1, 60), gun: null, flash: null, shell: null };
      s.scene.background = new THREE.Color('#0a1229');
      // SIDE-VIEW PROFILE of the WEAPON ONLY — the cannon fires FORWARD
      // (barrel up-left) and the projectile travels ALONG the barrel line
      s.cam.position.set(4.4, 1.5, 0.6);
      s.cam.lookAt(-1.2, 0.2, 1.4);
      s.scene.add(new THREE.HemisphereLight('#bfe8ff', '#123a5e', 1.1));
      const dl = new THREE.DirectionalLight('#fff2d0', 1.6); dl.position.set(3, 6, 2); s.scene.add(dl);
      // the EXACT gameplay gun mesh. The razorfin/rocket barrels keep the
      // slight UP angle of the original preview (user: "you flattened the
      // angle... restore those to the previous version"). The barge barrel
      // is mounted BACKWARDS in the builder (it droops toward the muzzle);
      // the preview flips it horizontally so the muzzle end rises.
      s.gun = buildWeapon(clsDef.id, 'w1', 0);
      if (clsDef.id === 'barge') {
        const barrel = s.gun.children[1]; // builder: [mount, barrel]
        if (barrel) barrel.rotation.x = -0.7;
      } else {
        s.gun.rotation.x = -0.3;
      }
      s.gun.rotation.y = -0.85;
      s.scene.add(s.gun);
      s.gun.updateMatrixWorld(true);
      // water the projectile lands in
      const wtr = new THREE.Mesh(new THREE.BoxGeometry(16, 0.3, 10), new THREE.MeshLambertMaterial({ color: '#0b3447' }));
      wtr.position.set(0, -0.55, 0); s.scene.add(wtr);
      s.flash = new THREE.Mesh(FX_UNIT_GEO, new THREE.MeshBasicMaterial({ color: '#ffe9a8' }));
      s.flash.scale.set(0.45, 0.45, 0.45); s.flash.visible = false;
      s.gun.add(s.flash);
      // per-class muzzle tip + axis IN GUN-LOCAL SPACE, measured from the
      // weapon builders (the barge barrel's flip is already applied above).
      // Both are mapped through the gun's REAL world matrix, so the exit
      // tangent is the actual barrel direction — no hand-tuned angles.
      const ML = {
        razorfin: { t: new THREE.Vector3(0, 0.15, 1.7), a: new THREE.Vector3(0, 0, 1) },
        barge: { t: new THREE.Vector3(0, 0.42 + 0.95 * Math.sin(0.7), 0.75 + 0.95 * Math.cos(0.7)), a: new THREE.Vector3(0, Math.sin(0.7), Math.cos(0.7)) },
        rocket: { t: new THREE.Vector3(0, 0, 0.69), a: new THREE.Vector3(0, 0, 1) },
      };
      const mk = ML[clsDef.id] || ML.razorfin;
      const tipL = mk.t.clone();
      const baseL = tipL.clone().addScaledVector(mk.a, -0.8);
      s.tip = s.gun.localToWorld(tipL);
      const baseW = s.gun.localToWorld(baseL);
      s.dir = s.tip.clone().sub(baseW).normalize();
      s.ctrl = s.tip.clone().addScaledVector(s.dir, 1.15);
      s.land = s.tip.clone().addScaledVector(s.dir, 2.6);
      s.land.y = -0.35; // splash point: on the water, further along the firing line
      s.flash.position.copy(tipL); // rides the REAL barrel tip
      // projectiles = the REAL in-game shells (same shared visual builder)
      const k = clsDef.id === 'razorfin' ? 'rail' : clsDef.id === 'barge' ? 'cannon' : 'rocket';
      s.shell = buildProjVisual(k);
      s.shell.visible = false; s.scene.add(s.shell);
      s.splash = new THREE.Mesh(FX_RING_GEO, new THREE.MeshBasicMaterial({ color: '#dff4ff', transparent: true, depthWrite: false }));
      s.splash.visible = false; s.scene.add(s.splash);
      // ---- special ability shot assets (phase B of the loop) ----
      s.kind = clsDef.id; // barge=mine drop, razorfin=gatling burst, rocket=rain missile
      s.mine = buildProjVisual('mine'); // the REAL spiky sea mine (core + bar)
      s.mine.visible = false; s.scene.add(s.mine);
      s.b2 = buildProjVisual(k); s.b3 = buildProjVisual(k);
      s.b2.visible = false; s.b3.visible = false; s.scene.add(s.b2); s.scene.add(s.b3);
      s.miss = buildProjVisual('rocket');
      s.miss.visible = false; s.scene.add(s.miss);
      // mine drop point: below/behind the gun, above the water
      s.mineDrop = new THREE.Vector3(-2.1, 1.1, 1.8);
      s.ctrl2 = s.tip.clone().add(new THREE.Vector3(-0.6, 1.4, 0.3)); // higher arc for the rain missile
      clipCache.set(clsDef.id, s);
    }
    // bezier flight: position on the curve + orientation along its tangent,
    // so the projectile exits EXACTLY along the barrel (control point lies
    // on the barrel axis) and then bends down into the water
    const _bA = new THREE.Vector3(), _bB = new THREE.Vector3(), _tgt = new THREE.Vector3();
    const bez = (m, p0, p1, p2, ft) => {
      const u = 1 - ft;
      _bA.copy(p0).multiplyScalar(u).addScaledVector(p1, ft);
      _bB.copy(p1).multiplyScalar(u).addScaledVector(p2, ft);
      m.position.copy(_bA).multiplyScalar(u).addScaledVector(_bB, ft);
      _tgt.copy(p1).sub(p0).multiplyScalar(2 * u).addScaledVector(_bB.copy(p2).sub(p1), 2 * ft);
      if (_tgt.lengthSq() > 1e-6) m.quaternion.setFromUnitVectors(_zAxis, _tgt.normalize());
    };
    const splashAnim = (m, at, st) => {
      m.position.set(at.x, at.y + 0.05, at.z);
      m.scale.set(0.5 + st * 2.2, 1, 0.5 + st * 2.2);
      m.material.opacity = 0.9 * (1 - st);
    };
    // ---- loop: one BASIC shot, then one SPECIAL ability shot ----
    const cyc = t % 5.2;
    // PHASE A — basic shot (0 → 2.15)
    const firing = cyc < 0.2;
    s.gun.position.z = firing ? -0.12 * (1 - cyc / 0.2) : 0;
    s.flash.visible = firing;
    const flyA = cyc >= 0.1 && cyc < 1.7;
    s.shell.visible = flyA;
    if (flyA) bez(s.shell, s.tip, s.ctrl, s.land, (cyc - 0.1) / 1.6);
    const splA = cyc >= 1.7 && cyc < 2.15;
    s.splash.visible = splA;
    if (splA) splashAnim(s.splash, s.land, (cyc - 1.7) / 0.45);
    // PHASE B — special ability shot (2.7 → 4.7, per class)
    const tb = cyc - 2.7;
    const inB = tb >= 0 && tb < 2.0;
    if (!inB) {
      s.mine.visible = false; s.b2.visible = false; s.b3.visible = false; s.miss.visible = false;
    } else if (s.kind === 'barge') {
      // MINE LAYER: the REAL spiky sea mine drops from the hull into the water
      const dropping = tb >= 0.1 && tb < 0.9;
      s.mine.visible = dropping;
      if (dropping) {
        const ft = (tb - 0.1) / 0.8;
        s.mine.position.set(s.mineDrop.x, 1.1 - 1.6 * ft, s.mineDrop.z);
        s.mine.rotation.y += 0.05;
        if (s.mine.userData.core) {
          s.mine.userData.core.scale.setScalar(0.7 + 0.5 * Math.sin(t * 7)); // in-game pulse
        }
      }
      const spl = tb >= 0.9 && tb < 1.3;
      s.splash.visible = spl;
      if (spl) splashAnim(s.splash, new THREE.Vector3(s.mineDrop.x, -0.4, s.mineDrop.z), (tb - 0.9) / 0.4);
    } else if (s.kind === 'razorfin') {
      // GATLING BURST: three rail slugs leave the barrel in quick succession
      s.flash.visible = tb >= 0.1 && tb < 0.5;
      const bolts = [s.shell, s.b2, s.b3];
      for (let i = 0; i < 3; i++) {
        const tbi = tb - 0.1 - i * 0.14;
        const vis = tbi >= 0 && tbi < 1.1;
        bolts[i].visible = vis;
        if (vis) bez(bolts[i], s.tip, s.ctrl, s.land, tbi / 1.1);
      }
      const spl = tb >= 1.2 && tb < 1.65;
      s.splash.visible = spl;
      if (spl) splashAnim(s.splash, s.land, (tb - 1.2) / 0.45);
    } else {
      // MISSILE RAIN: one missile on a higher arc, bigger splash
      const flying2 = tb >= 0.1 && tb < 1.55;
      s.miss.visible = flying2;
      if (flying2) bez(s.miss, s.tip, s.ctrl2, s.land, (tb - 0.1) / 1.45);
      const spl = tb >= 1.55 && tb < 2.0;
      s.splash.visible = spl;
      if (spl) splashAnim(s.splash, s.land, (tb - 1.55) / 0.45);
    }
    if (!previewRenderer || previewRenderer.domElement !== canvas) {
      previewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      previewRenderer.setPixelRatio(1);
    }
    previewRenderer.setSize(canvas.width, canvas.height, false);
    previewRenderer.render(s.scene, s.cam);
  }

  // ---------------- weapon-only card picture: PLAYING-CARD portrait (5:7),
  // the gun alone, no hull, no swatch ----------------
  function weaponImage(clsDef) {
    const sc = new THREE.Scene();
    sc.background = new THREE.Color('#0a1229');
    const cam = new THREE.PerspectiveCamera(34, 150 / 210, 0.1, 40);
    cam.position.set(4.6, 1.25, 0.9);
    cam.lookAt(0, 0.3, 0);
    sc.add(new THREE.HemisphereLight('#bfe8ff', '#123a5e', 1.1));
    const dl = new THREE.DirectionalLight('#fff2d0', 1.5); dl.position.set(3, 6, 2); sc.add(dl);
    const w = buildWeapon(clsDef.id, 'w1', 0);
    // barge barrel flips horizontally (it droops toward the muzzle in the
    // builder); razorfin/rocket keep the slight up-angle — matches the clip
    if (clsDef.id === 'barge') {
      const barrel = w.children[1]; // builder: [mount, barrel]
      if (barrel) barrel.rotation.x = -0.7;
    } else {
      w.rotation.x = -0.3;
    }
    w.rotation.y = -0.85;
    sc.add(w);
    if (!cardRenderer) {
      cardRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      cardRenderer.setPixelRatio(1);
    }
    cardRenderer.setSize(150, 210, false);
    cardRenderer.render(sc, cam);
    return cardRenderer.domElement.toDataURL();
  }

  // ---------------- style & cosmetics overlay preview ----------------
  // the CANOE as it will look in-game with the staged cosmetics (the same
  // buildCanoe the match uses), slowly orbiting + a colored wake ribbon for
  // trail options (the trail itself only shows while moving in-game).
  const cosmPrevCache = new Map(); // clsId -> { scene, cam, group, trail, lastSig, t0 }
  let cosmPreviewRenderer = null;
  function cosmeticPreview(clsDef, cosmetics, canvas) {
    const sig = JSON.stringify(cosmetics);
    let s = cosmPrevCache.get(clsDef.id);
    if (!s) {
      s = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(38, 360 / 230, 0.1, 60), group: null, trail: null, lastSig: '', t0: performance.now() };
      s.scene.background = new THREE.Color('#0a2a48');
      s.cam.position.set(7.6, 3.0, 7.6);
      s.cam.lookAt(0, 0.2, 0);
      s.scene.add(new THREE.HemisphereLight('#bfe8ff', '#123a5e', 1.1));
      const dl = new THREE.DirectionalLight('#fff2d0', 1.5); dl.position.set(4, 7, 3); s.scene.add(dl);
      // still water disc under the canoe
      const wtr = new THREE.Mesh(new THREE.CircleGeometry(9, 24),
        new THREE.MeshLambertMaterial({ color: '#0b3447' }));
      wtr.rotation.x = -Math.PI / 2;
      wtr.position.y = -0.62;
      s.scene.add(wtr);
      // wake-trail stream: the SAME emoji icon sprites the in-game jet stream
      // uses (trailIconTexture), trailing the stern and fading with distance —
      // the preview matches the in-game vfx by construction
      s.trail = new THREE.Group();
      for (let i = 0; i < 12; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: null, transparent: true, depthWrite: false }));
        sp.position.set((Math.random() - 0.5) * 0.8, -0.48, -2.2 - i * 0.72);
        const sc = 0.22 + Math.random() * 0.1;
        sp.scale.set(sc, sc, 1);
        sp.material.opacity = Math.max(0.12, 0.95 * (1 - i / 12));
        s.trail.add(sp);
      }
      s.scene.add(s.trail);
      cosmPrevCache.set(clsDef.id, s);
    }
    // CONSTANT slow rotation driven by wall-clock since scene creation — the
    // angle never resets, so swapping cosmetics mid-spin is seamless (only
    // the color/style/cosmetic changes; the orbit continues unbroken).
    const ang = ((performance.now() - s.t0) / 1000) * 0.35;
    if (s.lastSig !== sig) {
      s.lastSig = sig;
      if (s.group) {
        // detach the icon stream BEFORE disposal — it must survive the rebuild
        if (s.trail.parent) s.trail.parent.remove(s.trail);
        s.scene.remove(s.group); disposeGroup(s.group);
      }
      const built = buildCanoe(clsDef, cosmetics);
      const L = 3.3 * clsDef.size;
      const turret = new THREE.Group();
      turret.position.set(0, 0.35, L * 0.2);
      turret.add(buildWeapon(clsDef.id, 'w1', 0));
      built.hull.add(turret);
      built.group.rotation.y = ang; // continue the spin, no visual jump
      // attach the icon stream to the CANOE so it trails the stern while the
      // hull orbits
      built.group.add(s.trail);
      s.group = built.group;
      s.scene.add(s.group);
      // trail icons (none = no stream, in-game stays plain wake)
      const tdc = trailDef(cosmetics.trail);
      s.trail.visible = !!(tdc && tdc.icon);
      if (tdc && tdc.icon) {
        const tex = trailIconTexture(tdc.icon);
        for (const c of s.trail.children) { c.material.map = tex; c.material.needsUpdate = true; }
      }
    } else {
      s.group.rotation.y = ang;
    }
    if (!cosmPreviewRenderer || cosmPreviewRenderer.domElement !== canvas) {
      cosmPreviewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      cosmPreviewRenderer.setPixelRatio(1);
    }
    cosmPreviewRenderer.setSize(canvas.width, canvas.height, false);
    cosmPreviewRenderer.render(s.scene, s.cam);
  }

  // ---------------- camera ----------------
  // Eased chase cam: yaw swings around turns (no snapping), centrifugal lean,
  // boost pulls back slightly. Position/aim critically-damped.
  const camState = { dist: 13, yawOff: 0, pitchOff: 0.0, shake: 0, mode: 'chase', yawSm: 0, lean: 0, distCur: 13 };
  const camPos = new THREE.Vector3(0, 12, 20);
  const camLook = new THREE.Vector3(0, 1, 0);
  const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

  function updateCamera(focus, yaw, dt, opts = {}) {
    const c = camState;
    if (opts.mode === 'orbit') {
      c.yawOff += dt * 0.3;
      const p = focus;
      const dist = 22;
      const ca = Math.cos(c.pitchOff + 0.5), sa = Math.sin(c.pitchOff + 0.5);
      const target = new THREE.Vector3(
        p.x + Math.sin(c.yawOff) * dist * ca,
        p.y + 1 + dist * sa,
        p.z + Math.cos(c.yawOff) * dist * ca,
      );
      camPos.lerp(target, Math.min(1, dt * 4));
      camLook.lerp(new THREE.Vector3(p.x, p.y + 1, p.z), Math.min(1, dt * 4));
    } else {
      // eased yaw — the camera swings through turns instead of snapping behind
      c.yawSm += angDiff(yaw, c.yawSm) * Math.min(1, dt * 8.5);
      // centrifugal lean into the turn
      const leanT = Math.max(-1, Math.min(1, -(opts.turn || 0) * 0.3));
      c.lean += (leanT - c.lean) * Math.min(1, dt * 4);
      // boost eases the camera back a touch
      const distT = c.dist * (opts.boost ? 0.88 : 1);
      c.distCur += (distT - c.distCur) * Math.min(1, dt * 3);
      const cy = Math.cos(c.yawSm), sy = Math.sin(c.yawSm);
      const pitch = 0.42 + c.pitchOff;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const lx = -sy * c.lean * 2.4, lz = cy * c.lean * 2.4;
      const target = new THREE.Vector3(
        focus.x - cy * c.distCur * cp + lx + Math.sin(c.yawOff) * c.dist * 0.4,
        focus.y + 0.6 + c.distCur * sp + (focus.y > 0.5 ? focus.y * 0.5 : 0),
        focus.z - sy * c.distCur * cp + lz + Math.cos(c.yawOff) * c.dist * 0.4,
      );
      camPos.lerp(target, Math.min(1, dt * 10));
      camLook.lerp(new THREE.Vector3(focus.x + cy * 6, focus.y + 1.2, focus.z + sy * 6), Math.min(1, dt * 10));
    }
    c.shake = Math.max(0, c.shake - dt * 2.2);
    const sh = c.shake;
    camera.position.copy(camPos);
    camera.position.x += (Math.random() - 0.5) * sh;
    camera.position.y += (Math.random() - 0.5) * sh;
    camera.position.z += (Math.random() - 0.5) * sh;
    camera.lookAt(camLook);
  }

  function setCameraDrag(dx, dy) {
    const c = camState;
    if (c.mode === 'orbit') { c.yawOff += dx * 0.008; c.pitchOff = clamp(c.pitchOff + dy * 0.006, -0.2, 0.9); }
    else {
      c.yawOff = clamp(c.yawOff + dx * 0.006, -0.6, 0.6);
      c.pitchOff = clamp(c.pitchOff + dy * 0.006, -0.2, 0.55);
    }
  }
  function setCamMode(m) { camState.mode = m; }
  function zoom(d) { camState.dist = clamp(camState.dist + d, 7, 24); }
  function shake(n) { camState.shake = Math.min(0.45, camState.shake + n); }

  // ---------------- frame ----------------
  function render(dt) {
    const t0 = performance.now();
    time += dt;
    frameN++;
    // auto quality degradation: when the smoothed frame time stays above
    // 30 ms, drop to 'lo' once (never auto-upgrades — manual setQuality can)
    if (quality === 'hi') {
      degradeT += dt;
      if (degradeT > 2 && renderTime > 30) degradeQuality();
      else if (degradeT > 10) degradeT = 0;
    }
    waterUniforms.uTime.value = time;
    // clouds drift + zone beacons pulse
    for (const c of clouds) c.position.x += dt * 0.8;
    if (zoneGroup) {
      zoneGroup.traverse(o => { if (o.userData.beacon) o.scale.setScalar(0.75 + 0.4 * Math.sin(time * 5)); });
    }
    // arena life: corner flags wave, boundary buoys bob on the swell
    if (arenaGroup.userData.flags) {
      for (const f of arenaGroup.userData.flags) f.rotation.y = Math.sin(time * 3 + f.position.x * 0.1) * 0.35;
    }
    if (arenaGroup.userData.buoys) {
      for (const b of arenaGroup.userData.buoys) b.position.y = Math.abs(Math.sin(time * 1.6 + b.position.x * 0.05 + b.position.z * 0.05)) * 0.4;
    }
    // boost pads pulse (racing-pad glow)
    if (arenaGroup.userData.boostZones) {
      const pulse = 0.7 + Math.sin(time * 2.2) * 0.2;
      for (const p of arenaGroup.userData.boostZones) p.material.opacity = pulse;
    }
    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ttl -= dt;
      if (p.ttl <= 0) {
        scene.remove(p.mesh); p.mesh.visible = false; partPool.push(p.mesh);
        particles.splice(i, 1);
        continue;
      }
      p.vel.y += p.grav * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 3; p.mesh.rotation.y += dt * 2.5;
      const k = p.ttl / p.life;
      if (p.sink) p.mesh.position.y -= dt * 0.35;
      p.mesh.material.opacity = k;
      p.mesh.scale.setScalar(Math.max(0.01, k) * p.scale);
    }
    // trail icon pixels: drift backward, sink into the ocean, fade out
    for (let i = trailIcons.length - 1; i >= 0; i--) {
      const ti = trailIcons[i];
      ti.ttl -= dt;
      if (ti.ttl <= 0) {
        ti.sp.visible = false;
        trailIconPool.push(ti.sp);
        trailIcons.splice(i, 1);
        continue;
      }
      ti.vy -= 0.55 * dt; // they float DOWN to the bottom of the ocean
      ti.sp.position.x += ti.vx * dt;
      ti.sp.position.y += ti.vy * dt;
      ti.sp.position.z += ti.vz * dt;
      const k = ti.ttl / ti.life;
      ti.sp.material.opacity = 0.95 * k;
      const s = ti.sp.scale.x * (1 - dt * 0.25);
      ti.sp.scale.set(s, s, 1);
      ti.sp.material.rotation = ti.spin + ti.ttl * 2;
    }
    // CANNON COVE telegraphs: pulse the red ring + beacon, expire with the warn
    for (let i = warnFx.length - 1; i >= 0; i--) {
      const w = warnFx[i];
      w.ttl -= dt;
      if (w.ttl <= 0) {
        scene.remove(w.ring); scene.remove(w.beacon);
        warnFx.splice(i, 1);
        continue;
      }
      const k = w.ttl / w.life;
      const pulse = 0.55 + 0.45 * Math.sin(time * 14);
      w.ring.scale.setScalar(0.8 + (1 - k) * 2.6);
      w.ring.material.opacity = 0.75 * k * (0.5 + pulse * 0.5);
      w.beacon.material.opacity = 0.4 * k * (0.5 + pulse * 0.5);
    }
    // fortress cannon recoil: barrel kicks back on fire, eases forward
    if (arenaGroup && arenaGroup.userData.cannons) {
      for (const bat of arenaGroup.userData.cannons) {
        if (!bat.userData.recoil) continue;
        bat.userData.recoil = Math.max(0, bat.userData.recoil - dt * 3);
        bat.children[2].position.z = 0.9 - 0.45 * bat.userData.recoil;
      }
    }
    // fx anims
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i];
      e.ttl -= dt;
      const k = e.ttl / e.life;
      if (e.ttl <= 0) {
        if (e.mesh) {
          scene.remove(e.mesh);
          // dispose the texture too — sprite maps (damage numbers) leaked
          // GPU uploads per hit until nothing was left to render smoothly.
          // NOTE: geometry is NOT disposed — fx meshes share the two
          // module-level unit geometries (FX_UNIT_GEO / FX_RING_GEO).
          if (e.mesh.material) {
            if (e.mesh.material.map) e.mesh.material.map.dispose();
            e.mesh.material.dispose();
          }
        }
        if (e.light) { scene.remove(e.light); boomLightCount = Math.max(0, boomLightCount - 1); }
        fx.splice(i, 1);
        continue;
      }
      if (e.type === 'flash') { const s = (1 - k) * e.target; e.mesh.scale.setScalar(Math.max(0.3, s)); e.mesh.material.opacity = k; }
      if (e.type === 'ring') { e.mesh.scale.set((1 - k) * e.target, 1, (1 - k) * e.target); e.mesh.material.opacity = k * 0.8; }
      if (e.type === 'muzzle') { e.mesh.material.opacity = k; }
      if (e.type === 'dmg') { e.mesh.position.y += dt * 1.6; e.mesh.material.opacity = k; }
      if (e.type === 'light') { e.light.intensity = k * 60; }
    }
    // damage-state smoke from burning canoes
    for (const pv of players.values()) {
      if (pv.dmgState >= 2 && pv.group.visible) {
        pv.smokeT -= dt;
        if (pv.smokeT <= 0) {
          pv.smokeT = 0.3;
          if (particles.length < 90) {
            pv.hull.updateWorldMatrix(true, false);
            const v = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.85, (Math.random() - 0.5) * 1.8);
            pv.hull.localToWorld(v);
            spawnParticle(v, 0.22 + Math.random() * 0.18, '#3a3a40', false,
              new THREE.Vector3((Math.random() - 0.5) * 0.8, 1.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8),
              0.8 + Math.random() * 0.4, 0.3);
          }
        }
      }
    }
    // ---- canoe wakes (AA fidelity): foam trails behind moving hulls ----
    for (const pv of players.values()) {
      if (!pv.group.visible) continue;
      const gx = pv.group.position.x, gz = pv.group.position.z;
      const spd = Math.hypot(gx - (pv.lastX || gx), gz - (pv.lastZ || gz)) / Math.max(dt, 0.001);
      pv.lastX = gx; pv.lastZ = gz;
      if (spd > 4) {
        pv.wakeT = (pv.wakeT || 0) - dt;
        if (pv.wakeT <= 0) {
          pv.wakeT = 0.11;
          const ang = Math.PI / 2 - pv.group.rotation.y; // render mounts hulls at π/2 − yaw
          const bx = gx - Math.cos(ang) * 2.0 + (Math.random() - 0.5) * 0.7;
          const bz = gz - Math.sin(ang) * 2.0 + (Math.random() - 0.5) * 0.7;
          wakeSpawn(bx, bz, pv.cosmetics && pv.cosmetics.trail);
        }
      }
    }
    // wake foam fades + spreads as it dies
    for (let i = wakes.length - 1; i >= 0; i--) {
      const w = wakes[i];
      w.ttl -= dt;
      if (w.ttl <= 0) { scene.remove(w.mesh); w.mesh.visible = false; wakePool.push(w.mesh); wakes.splice(i, 1); continue; }
      const k = w.ttl / w.life;
      w.mesh.material.opacity = 0.55 * k;
      w.mesh.scale.x += dt * 0.9; w.mesh.scale.z += dt * 0.9;
    }
    if (ocean) {
      // 30 Hz decimation: the FFT phase evolution is an EXACT function of
      // time (h·e^{iωt} — no frame-to-frame dependency), and the reflection
      // is already a wave-distorted smear, so both update on alternate
      // frames. The mirror matrix still updates every frame so the
      // projective UV tracks the live camera.
      if (frameN & 1) ocean.update(time);
      skyMat.uniforms.uTime.value = time;
      mirrorWorldPosition.setFromMatrixPosition(camera.matrixWorld);
      mirrorWorldPosition.y *= -1;
      mirrorCam.position.copy(mirrorWorldPosition);
      mirrorQuat.setFromRotationMatrix(camera.matrixWorld);
      mirrorQuat.x *= -1;
      mirrorQuat.z *= -1;
      mirrorCam.quaternion.copy(mirrorQuat);
      mirrorCam.updateMatrixWorld();
      mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
      mirrorInv.copy(mirrorCam.matrixWorld).invert();
      waterUniforms.uMirrorMatrix.value.multiplyMatrices(mirrorCam.projectionMatrix, mirrorInv);
      if (frameN & 1) {
        renderer.setRenderTarget(reflRT);
        renderer.clippingPlanes = [waterClipPlane];
        renderer.render(scene, mirrorCam);
        renderer.clippingPlanes = [];
        renderer.setRenderTarget(null);
      }
    } else {
      skyMat.uniforms.uTime.value = time;
    }
    // AA bloom on the hi tier; direct render on lo (or if bloom failed)
    if (composer && quality === 'hi') composer.render();
    else renderer.render(scene, camera);
    renderTime = renderTime * 0.9 + Math.max(0.1, performance.now() - t0) * 0.1;
  }

  // ---------------- debug helpers ----------------
  function sample(n = 8) {
    const w = canvas.width, h = canvas.height;
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const ctx2 = c2.getContext('2d');
    ctx2.drawImage(canvas, 0, 0);
    const img = ctx2.getImageData(0, 0, w, h);
    const out = [];
    for (let gy = 0; gy < n; gy++) {
      const row = [];
      for (let gx = 0; gx < n; gx++) {
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let y = Math.floor(gy * h / n); y < (gy + 1) * h / n; y += 8) {
          for (let x = Math.floor(gx * w / n); x < (gx + 1) * w / n; x += 8) {
            const i = (y * w + x) * 4;
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; cnt++;
          }
        }
        row.push('#' + [r, g, b].map(v => Math.round(v / cnt).toString(16).padStart(2, '0')).join(''));
      }
      out.push(row.join(' '));
    }
    return out;
  }

  function shot() {
    const data = canvas.toDataURL('image/png');
    fetch('/shot', { method: 'POST', body: data }).then(() => {});
  }

  // ---- quality tier manager ----
  // 'lo' = FFT N=128, quarter-res reflection, 192-seg water, DPR 1.0 —
  // for slow GPUs / software rendering. setQuality can also be called
  // manually (window.__dbg.game.setQuality('lo')).
  function resizeRefl() {
    const div = quality === 'hi' ? 2 : 4;
    reflRT.setSize(
      Math.max(2, Math.floor(window.innerWidth / div)),
      Math.max(2, Math.floor(window.innerHeight / div)));
  }

  function setQuality(q) {
    const next = q === 'lo' ? 'lo' : 'hi';
    if (next === quality) return;
    quality = next;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'hi' ? 1.25 : 1.0));
    // AA shadows only on hi — lo drops to PCF 1024 (fill-rate protection)
    renderer.shadowMap.type = quality === 'hi' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    sun.shadow.mapSize.setScalar(quality === 'hi' ? 2048 : 1024);
    resizeRefl();
    const seg = quality === 'hi' ? 288 : 192;
    if (water.geometry.parameters.widthSegments !== seg) {
      water.geometry.dispose();
      water.geometry = new THREE.BoxGeometry(900, 2, 900, seg, 1, seg);
    }
    const wantN = quality === 'hi' ? 256 : 128;
    if (ocean && ocean.N !== wantN) {
      ocean.dispose();
      try { ocean = createOcean(renderer, { size: wantN }); }
      catch (e) { console.log('ocean rebuild failed:', e && e.message); ocean = null; }
      if (ocean) {
        waterUniforms.tDisp.value = ocean.dispTex;
        waterUniforms.tDispZ.value = ocean.dispZTex;
        waterUniforms.tNormal.value = ocean.normalTex;
      }
    }
  }

  function degradeQuality() { setQuality('lo'); }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
    resizeRefl();
  });

  return {
    scene, camera, renderer,
    // live getter: after a quality-tier rebuild the ocean object is replaced,
    // so a snapshot taken at return time would point at disposed RTs
    get ocean() {
      if (!ocean) return null;
      return { dispRT: ocean.dispRT, dispZRT: ocean.dispZRT, normalRT: ocean.normalRT, spectrum1RT: ocean.spectrum1RT, spectrum2RT: ocean.spectrum2RT, phase1RT: ocean.phase1RT, phase2RT: ocean.phase2RT, fftA: ocean.fftA, fftB: ocean.fftB, reflRT, update: ocean.update, readback: ocean.readback, debug: ocean.debug, dispose: ocean.dispose };
    },
    get quality() { return quality; },
    setQuality,
    setMap: buildArena,
    stats: () => ({ draws: renderer.info.render.calls, tris: renderer.info.render.triangles, parts: particles.length, trailIcons: trailIcons.length, tex: renderer.info.memory.textures, fps: Math.round(1000 / Math.max(16.7, renderTime)), ql: quality }),
    setZone, canoeImage, classClipFrame, weaponImage, cosmeticPreview, setAimMarkers,
    setMyId: (id) => { myIdRef.current = id; },
    get players() { return players; },
    setAimPath, clearAimPath,
    upsertPlayer, removePlayer, applyPlayer, syncUpgradePickup,
    syncProjectiles, syncCrates, syncPickups,
    handleFx, shake,
    updateCamera, setCameraDrag, setCamMode, zoom,
    render, sample, shot,
    time: () => time,
  };
}
