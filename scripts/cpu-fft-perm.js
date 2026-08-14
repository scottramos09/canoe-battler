// Corrected algorithm: explicit bit-reversal permutation + plain-twiddle DIT.
// Verify against the analytic plane wave from an impulse spectrum.
const N = 256;
const TAU = Math.PI * 2;

function bitRev(x, bits) {
  let r = 0;
  for (let i = 0; i < bits; i++) { r = r * 2 + (x % 2); x = Math.floor(x / 2); }
  return r;
}

const K1 = 3, K2 = 5;
const spec = new Float64Array(N * N * 2);
spec[(K2 * N + K1) * 2] = 1;

// 1) row permutation: out[bitrev(x), y] = in[x, y]
function permuteRows(A) {
  const out = new Float64Array(A.length);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const rx = bitRev(x, 8);
      out[(y * N + rx) * 2] = A[(y * N + x) * 2];
      out[(y * N + rx) * 2 + 1] = A[(y * N + x) * 2 + 1];
    }
  }
  return out;
}
function permuteCols(A) {
  const out = new Float64Array(A.length);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ry = bitRev(y, 8);
      out[(ry * N + x) * 2] = A[(y * N + x) * 2];
      out[(ry * N + x) * 2 + 1] = A[(y * N + x) * 2 + 1];
    }
  }
  return out;
}

// 2) the plain-twiddle DIT along one axis (the input already permuted)
function fftAxis(A, axis) {
  const STAGES = Math.log2(N);
  for (let s = 0; s < STAGES; s++) {
    const size = 2 ** (s + 1), half = size / 2;
    const out = new Float64Array(A.length);
    for (let line = 0; line < N; line++) {
      for (let k = 0; k < N; k++) {
        const idx = axis === 0 ? (line * N + k) * 2 : (k * N + line) * 2; // texel (line, k): row-major k*N+line for the columns
        const t2 = k % half;
        const j = Math.floor(k / size) * size + t2;
        const aIdx = axis === 0 ? (line * N + j) * 2 : (j * N + line) * 2;
        const bIdx = axis === 0 ? (line * N + j + half) * 2 : ((j + half) * N + line) * 2;
        const ph = -TAU * t2 / size; // PLAIN twiddle
        const twr = Math.cos(ph), twi = Math.sin(ph);
        const aR = A[aIdx], aI = A[aIdx + 1];
        const bR = A[bIdx], bI = A[bIdx + 1];
        const bpR = twr * bR - twi * bI, bpI = twr * bI + twi * bR;
        const sg = (k % size < half) ? 1 : -1;
        out[idx] = aR + sg * bpR;
        out[idx + 1] = aI + sg * bpI;
      }
    }
    A = out;
  }
  return A;
}

let A = permuteRows(spec);
A = fftAxis(A, 0);
A = permuteCols(A);
A = fftAxis(A, 1);
const sc = 1 / (N * N);
const H = new Float64Array(N * N);
for (let i = 0; i < N * N; i++) H[i] = A[i * 2] * sc;

let maxErr = 0;
for (let y = 0; y < N; y += 4) {
  for (let x = 0; x < N; x += 4) {
    const want = Math.cos(TAU * (K1 * x + K2 * y) / N);
    const e = Math.abs(H[y * N + x] - want);
    if (e > maxErr) maxErr = e;
  }
}
let mean = 0;
for (let i = 0; i < N * N; i++) mean += H[i];
mean /= N * N;
let varc = 0;
for (let i = 0; i < N * N; i++) varc += (H[i] - mean) ** 2;
varc /= N * N;
let c1 = 0, cnt = 0;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N - 2; x++) {
    c1 += (H[y * N + x] - mean) * (H[y * N + x + 1] - mean);
    cnt++;
  }
}
c1 /= cnt * varc;
console.log(`perm+plain DIT: maxErr = ${maxErr.toFixed(6)} (want < 1e-6)`);
console.log(`corr1 = ${c1.toFixed(4)} (want ~0.9973)`);
console.log(maxErr < 1e-6 ? '✅ PERMUTATION + PLAIN DIT IS CORRECT' : '❌ STILL WRONG');
