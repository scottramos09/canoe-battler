// ============================================================
// CANOE ARENA — Tessendorf-style FFT ocean (visual surface only).
// The boats keep riding the analytic waveH() (server physics —
// deterministic, sim-locked); this module produces the DISPLACEMENT
// and NORMAL/FOAM textures the water surface samples, so the sea
// gets a full ocean spectrum (Phillips) with choppy crests and
// Jacobian whitecaps, and the hulls ride the same ±1.3 u swell.
// ============================================================
import * as THREE from 'three';

const TAU = Math.PI * 2;

// ---- fullscreen-pass vertex (plane 2x2 -> clip space, uv passthrough) ----
const FS_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// ---- spectrum init (once): Phillips amplitudes + choppy components ----
// texel (i,j) <-> wave vector k = 2π·(i,j)/tile; DC texel is zeroed.
// RGBA out = (h1, h2, Dx1, Dx2)  [two complex pairs: height + x-displacement]
const SPECTRUM_V1 = `
precision highp float;
uniform sampler2D randTex;
uniform float n;
uniform float tile;
uniform float wind;
uniform float amp;
uniform vec2 windDir;
varying vec2 vUv;
void main() {
  vec2 coord = gl_FragCoord.xy - 0.5;
  float r = length(coord);
  float k = ${TAU.toFixed(7)} * r / tile;
  float L = wind * wind / 9.81;
  float P = 0.0;
  if (r > 0.5) {
    vec2 khat = coord / r;
    float align = abs(dot(khat, windDir)) + 0.03;
    P = amp * exp(-1.0 / (k * k * L * L)) / (k * k * k * k) * align * align;
  }
  // real-symmetric random amplitudes (the mirrored average) so the field is real
  vec4 rnd = texture2D(randTex, vUv);
  vec4 rndm = texture2D(randTex, vec2(1.0) - vUv);
  float h1 = (rnd.x + rndm.x) * 0.70710678;
  float h2 = (rnd.y + rndm.y) * 0.70710678;
  float s = sqrt(P);
  vec2 d = vec2(0.0);
  if (r > 0.5) d = (coord / r) * vec2(h2, -h1) * s;   // D = -i·k̂·h
  gl_FragColor = vec4(h1 * s, h2 * s, d.x, d.y);
}`;

// ---- spectrum init 2: the z-displacement spectrum (Dz1, Dz2) ----
const SPECTRUM_V2 = `
precision highp float;
uniform sampler2D randTex;
uniform float n;
uniform float tile;
uniform float wind;
uniform float amp;
uniform vec2 windDir;
varying vec2 vUv;
void main() {
  vec2 coord = gl_FragCoord.xy - 0.5;
  float r = length(coord);
  float k = ${TAU.toFixed(7)} * r / tile;
  float L = wind * wind / 9.81;
  float P = 0.0;
  if (r > 0.5) {
    vec2 khat = coord / r;
    float align = abs(dot(khat, windDir)) + 0.03;
    P = amp * exp(-1.0 / (k * k * L * L)) / (k * k * k * k) * align * align;
  }
  vec4 rnd = texture2D(randTex, vUv);
  vec4 rndm = texture2D(randTex, vec2(1.0) - vUv);
  float h1 = (rnd.x + rndm.x) * 0.70710678;
  float h2 = (rnd.y + rndm.y) * 0.70710678;
  float s = sqrt(P);
  vec2 d = vec2(0.0);
  if (r > 0.5) d = vec2(coord.y / r * h2 * s, -coord.y / r * h1 * s);
  gl_FragColor = vec4(d.x, d.y, 0.0, 0.0);
}`;

// ---- time evolution: h(k,t) = h0(k)·exp(i·ω(k)·t), ω = √(g·k) ----
const PHASE_FS = `
precision highp float;
uniform float time;
uniform float tile;
uniform sampler2D uInput;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(uInput, vUv);
  float r = length(gl_FragCoord.xy - 0.5);
  float k = ${TAU.toFixed(7)} * r / tile;
  float ph = sqrt(9.81 * k) * time;
  vec2 c = vec2(cos(ph), sin(ph));
  gl_FragColor = vec4(
    s.x * c.x - s.y * c.y, s.x * c.y + s.y * c.x,
    s.z * c.x - s.w * c.y, s.z * c.y + s.w * c.x);
}`;

// ---- radix-2 DIT butterfly with bit-reversed twiddles (in-place, no
//      input permutation — hand-verified for N=4) ----
const FFT_FS = `
precision highp float;
uniform sampler2D uInput;
uniform float size;
uniform float uHalf;
uniform float revBits;
uniform vec2 direction;
uniform float n;
varying vec2 vUv;
float bitRev(float x, float bits) {
  float r = 0.0;
  for (int i = 0; i < 9; i++) {
    if (float(i) < bits) { r = r * 2.0 + mod(x, 2.0); x = floor(x / 2.0); }
  }
  return r;
}
void main() {
  float outIdx = floor(dot(vUv, direction) * n);
  float t = mod(outIdx, uHalf);
  float j = floor(outIdx / size) * size + t;
  vec2 uvA = vUv - direction * ((outIdx - j) / n);
  vec2 uvB = uvA + direction * (uHalf / n);
  vec4 a = texture2D(uInput, uvA);
  vec4 b = texture2D(uInput, uvB);
  // PLAIN twiddle exponent (the input permutation pass handles the ordering)
  float ph = -6.283185307179586 * t / size;
  vec2 tw = vec2(cos(ph), sin(ph));
  // GLSL vec2*vec2 is COMPONENT-WISE, not complex multiplication — the
  // cross terms must be explicit (the stage-0 twiddle (1,0) masked this:
  // component-wise happens to equal complex there, so the first stage
  // verified clean while every later stage was wrong)
  vec2 bp = vec2(tw.x * b.x - tw.y * b.y, tw.x * b.y + tw.y * b.x);
  vec2 bq = vec2(tw.x * b.z - tw.y * b.w, tw.x * b.w + tw.y * b.z);
  float sg = (mod(outIdx, size) < uHalf) ? 1.0 : -1.0;
  gl_FragColor = vec4(a.xy + sg * bp, a.zw + sg * bq);
}`;

// ---- the bit-reversal permutation pass (the DIT's input permutation) ----
const PERM_FS = `
precision highp float;
uniform sampler2D uInput;
uniform float n;
uniform float bits;
uniform float axis; // 0 = rows (x), 1 = columns (y)
varying vec2 vUv;
float bitRev(float x, float bits) {
  float r = 0.0;
  for (int i = 0; i < 9; i++) {
    if (float(i) < bits) { r = r * 2.0 + mod(x, 2.0); x = floor(x / 2.0); }
  }
  return r;
}
void main() {
  float px = floor(vUv.x * n);
  float py = floor(vUv.y * n);
  float rp = bitRev(axis < 0.5 ? px : py, bits);
  vec2 uvIn = axis < 0.5 ? vec2((rp + 0.5) / n, vUv.y) : vec2(vUv.x, (rp + 0.5) / n);
  gl_FragColor = texture2D(uInput, uvIn);
}`;

// ---- the IFFT scaling/copy pass ----
const PIXELS_FS = `
precision highp float;
uniform sampler2D uInput;
uniform float scale;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uInput, vUv) * scale; }`;

// ---- normals + Jacobian whitecaps from the displacement fields ----
const NORMAL_FS = `
precision highp float;
uniform sampler2D disp;
uniform sampler2D dispZ;
uniform float n;
uniform float tile;
varying vec2 vUv;
void main() {
  float px = 1.0 / n;
  vec4 c = texture2D(disp, vUv);
  float H = c.r;
  float Hx1 = texture2D(disp, vUv + vec2(px, 0.0)).r;
  float Hx2 = texture2D(disp, vUv - vec2(px, 0.0)).r;
  float Hz1 = texture2D(disp, vUv + vec2(0.0, px)).r;
  float Hz2 = texture2D(disp, vUv - vec2(0.0, px)).r;
  float dHx = (Hx1 - Hx2) * 0.5 * n;
  float dHz = (Hz1 - Hz2) * 0.5 * n;
  float scl = n / tile;
  vec3 nrm = normalize(vec3(-dHx * scl, 1.0, -dHz * scl));
  // the displacement Jacobian: J = (1+∂Dx/∂x)(1+∂Dz/∂z) − ∂Dx/∂z·∂Dz/∂x
  float dDxdx = (texture2D(disp, vUv + vec2(px, 0.0)).b - texture2D(disp, vUv - vec2(px, 0.0)).b) * 0.5 * n * scl;
  float dDzdz = (texture2D(dispZ, vUv + vec2(0.0, px)).r - texture2D(dispZ, vUv - vec2(0.0, px)).r) * 0.5 * n * scl;
  float dDxdz = (texture2D(dispZ, vUv + vec2(px, 0.0)).r - texture2D(dispZ, vUv - vec2(px, 0.0)).r) * 0.5 * n * scl;
  float dDzdx = (texture2D(disp, vUv + vec2(0.0, px)).b - texture2D(disp, vUv - vec2(0.0, px)).b) * 0.5 * n * scl;
  float jac = (1.0 + dDxdx) * (1.0 + dDzdz) - dDxdz * dDzdx;
  // whitecaps: power-curved so ONLY the sharpest crest compression foams
  // (a linear scale left ~31% of the surface > 0.5 foam = a foam sheet)
  float foam = pow(clamp(1.0 - min(jac, 1.0), 0.0, 1.0), 2.5);
  gl_FragColor = vec4(nrm * 0.5 + 0.5, foam);
}`;

function floatRT(w, h, linear = false) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  });
}

export function createOcean(renderer, opts = {}) {
  const N = opts.size || 256;
  const tile = opts.tile || 900;
  const STAGES = Math.round(Math.log2(N));

  // the random phase texture (the spectrum init samples it)
  const rc = document.createElement('canvas');
  rc.width = N; rc.height = N;
  const rctx = rc.getContext('2d');
  const img = rctx.createImageData(N, N);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.random() * 255;
    img.data[i + 1] = Math.random() * 255;
    img.data[i + 2] = Math.random() * 255;
    img.data[i + 3] = 255;
  }
  rctx.putImageData(img, 0, 0);
  const randTex = new THREE.CanvasTexture(rc);
  randTex.wrapS = randTex.wrapT = THREE.ClampToEdgeWrapping;

  // render targets
  const spectrum1RT = floatRT(N, N), spectrum2RT = floatRT(N, N);
  const phase1RT = floatRT(N, N), phase2RT = floatRT(N, N);
  const fftA = floatRT(N, N), fftB = floatRT(N, N);
  const dispRT = floatRT(N, N, true), dispZRT = floatRT(N, N, true);
  const normalRT = floatRT(N, N, true);

  const spectrum1Mat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: SPECTRUM_V1, uniforms: { randTex: { value: randTex }, n: { value: N }, tile: { value: tile }, wind: { value: opts.wind || 9 }, amp: { value: opts.amp != null ? opts.amp : 30 }, windDir: { value: new THREE.Vector2(0.6, 0.8).normalize() } } });
  const spectrum2Mat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: SPECTRUM_V2, uniforms: { randTex: { value: randTex }, n: { value: N }, tile: { value: tile }, wind: { value: opts.wind || 9 }, amp: { value: opts.amp != null ? opts.amp : 30 }, windDir: { value: spectrum1Mat.uniforms.windDir.value } } });
  const phaseMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: PHASE_FS, uniforms: { time: { value: 0 }, tile: { value: tile }, uInput: { value: null } } });
  const fftMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: FFT_FS, uniforms: { uInput: { value: null }, size: { value: 2 }, uHalf: { value: 1 }, revBits: { value: 0 }, direction: { value: new THREE.Vector2(1, 0) }, n: { value: N } } });
  const pixelsMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: PIXELS_FS, uniforms: { uInput: { value: null }, scale: { value: 1 / (N * N) } } });
  const permMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: PERM_FS, uniforms: { uInput: { value: null }, n: { value: N }, bits: { value: STAGES }, axis: { value: 0 } } });
  const normalMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: NORMAL_FS, uniforms: { disp: { value: null }, dispZ: { value: null }, n: { value: N }, tile: { value: tile } } });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), spectrum1Mat);
  const blitScene = new THREE.Scene();
  blitScene.add(quad);
  const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function blit(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(blitScene, blitCam);
    renderer.setRenderTarget(null);
  }

  // the 2D FFT: the bit-reversal input permutation (rows), the plain-twiddle
  // DIT row stages, the column permutation, the column stages. The old
  // bit-reversed-TWIDDLE variant was WRONG (it passed the N=4 hand-check
  // because the 1-bit reversal is the identity, then diverged from stage 2
  // on) — the permutation must be explicit.
  function runFFT(phaseRT, outRT) {
    permMat.uniforms.uInput.value = phaseRT.texture;
    permMat.uniforms.bits.value = STAGES;
    permMat.uniforms.axis.value = 0;
    blit(permMat, fftA);
    let src = fftA;
    for (let s = 0; s < STAGES; s++) {
      const size = Math.pow(2, s + 1);
      const dst = (src === fftA) ? fftB : fftA;
      fftMat.uniforms.uInput.value = src.texture;
      fftMat.uniforms.size.value = size;
      fftMat.uniforms.uHalf.value = size / 2;
      fftMat.uniforms.direction.value.set(1, 0);
      blit(fftMat, dst);
      src = dst;
    }
    permMat.uniforms.uInput.value = src.texture;
    permMat.uniforms.axis.value = 1;
    blit(permMat, fftB);
    src = fftB;
    for (let s = 0; s < STAGES; s++) {
      const size = Math.pow(2, s + 1);
      const dst = (src === fftA) ? fftB : fftA;
      fftMat.uniforms.uInput.value = src.texture;
      fftMat.uniforms.size.value = size;
      fftMat.uniforms.uHalf.value = size / 2;
      fftMat.uniforms.direction.value.set(0, 1);
      blit(fftMat, dst);
      src = dst;
    }
    pixelsMat.uniforms.uInput.value = src.texture;
    blit(pixelsMat, outRT);
  }

  // spectrum init (once)
  blit(spectrum1Mat, spectrum1RT);
  blit(spectrum2Mat, spectrum2RT);

  return {
    N,
    dispTex: dispRT.texture,
    dispZTex: dispZRT.texture,
    normalTex: normalRT.texture,
    dispRT, dispZRT, normalRT,
    spectrum1RT, spectrum2RT, phase1RT, phase2RT, fftA, fftB,
    debug: { randCanvas: rc, spectrum1Mat, spectrum2Mat, phaseMat, fftMat, pixelsMat, normalMat, permMat, blit, quad, blitCam, blitScene },
    update(t) {
      phaseMat.uniforms.time.value = t;
      phaseMat.uniforms.uInput.value = spectrum1RT.texture;
      blit(phaseMat, phase1RT);
      phaseMat.uniforms.uInput.value = spectrum2RT.texture;
      blit(phaseMat, phase2RT);
      runFFT(phase1RT, dispRT);
      runFFT(phase2RT, dispZRT);
      normalMat.uniforms.disp.value = dispRT.texture;
      normalMat.uniforms.dispZ.value = dispZRT.texture;
      blit(normalMat, normalRT);
    },
    readback(rt, x, y, w, h) {
      const buf = new Float32Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
      return Array.from(buf);
    },
    // quality-tier rebuild: free every RT/texture/material so a lower-N
    // ocean can replace this one without leaking GPU memory
    dispose() {
      for (const rt of [spectrum1RT, spectrum2RT, phase1RT, phase2RT, fftA, fftB, dispRT, dispZRT, normalRT]) rt.dispose();
      randTex.dispose();
      for (const m of [spectrum1Mat, spectrum2Mat, phaseMat, fftMat, pixelsMat, normalMat, permMat]) m.dispose();
      quad.geometry.dispose();
    },
  };
}
