// Minimal PNG decoder: report size + 8x8 color grid + dominant color
const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
const buf = fs.readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) { console.log('not png'); process.exit(1); }

let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  if (type === 'IHDR') {
    w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12);
    bitDepth = buf[off + 16]; colorType = buf[off + 17];
  } else if (type === 'IDAT') {
    idat.push(buf.slice(off + 8, off + 8 + len));
  } else if (type === 'IEND') break;
  off += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
const stride = w * channels;
console.log(`size ${w}x${h} bitDepth ${bitDepth} colorType ${colorType} raw ${raw.length}`);

// unfilter
const out = Buffer.alloc(h * stride);
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)];
  const row = y * stride;
  for (let x = 0; x < stride; x++) {
    const rawI = y * (stride + 1) + 1 + x;
    const left = x >= channels ? out[row + x - channels] : 0;
    const up = y > 0 ? out[row - stride + x] : 0;
    const ul = y > 0 && x >= channels ? out[row - stride + x - channels] : 0;
    let v = raw[rawI];
    if (f === 1) v += left;
    else if (f === 2) v += up;
    else if (f === 3) v += (left + up) >> 1;
    else if (f === 4) v += paeth(left, up, ul);
    out[row + x] = v & 0xff;
  }
}

// sample grid
const N = 8;
console.log('--- 8x8 grid ---');
for (let gy = 0; gy < N; gy++) {
  const row = [];
  for (let gx = 0; gx < N; gx++) {
    const x = Math.floor((gx + 0.5) * w / N), y = Math.floor((gy + 0.5) * h / N);
    const i = (y * stride) + x * channels;
    const r = out[i], g2 = out[i + 1], b = out[i + 2];
    row.push('#' + [r, g2, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  }
  console.log(row.join(' '));
}
// unique colors count (sample)
const seen = new Set();
for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 7) {
  const i = y * stride + x * channels;
  seen.add(`${out[i]},${out[i + 1]},${out[i + 2]}`);
}
console.log('unique sampled colors:', seen.size);
