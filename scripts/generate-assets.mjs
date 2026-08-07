import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const TEXTURE_DIR = join(ROOT, 'public/assets/textures');
const AUDIO_DIR = join(ROOT, 'public/assets/audio');
const SOURCE_DIR = join(ROOT, 'assets/source');
const SAMPLE_RATE = 22050;

mkdirSync(TEXTURE_DIR, { recursive: true });
mkdirSync(AUDIO_DIR, { recursive: true });

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function writeTexture(name, size, pixel) {
  const scanlines = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const offset = row + 1 + x * 3;
      scanlines[offset] = Math.max(0, Math.min(255, Math.round(r)));
      scanlines[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
      scanlines[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(join(TEXTURE_DIR, name), png);
}

function hash2(x, y, seed) {
  let h = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function periodicNoise(x, y, size, seed) {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  return (
    Math.sin(u * 3 + seed) * 0.32
    + Math.cos(v * 4 - seed * 0.7) * 0.27
    + Math.sin((u + v) * 7 + seed * 1.3) * 0.19
    + Math.cos((u - v) * 11 - seed * 0.4) * 0.12
    + Math.sin(u * 23 + Math.cos(v * 5)) * 0.1
  );
}

writeTexture('plaster-detail.png', 256, (x, y, size) => {
  const n = periodicNoise(x, y, size, 1.7);
  const fleck = hash2(x, y, 41) > 0.975 ? -18 : 0;
  const value = 226 + n * 16 + fleck;
  return [value + 3, value + 1, value - 3];
});

writeTexture('terrain-detail.png', 256, (x, y, size) => {
  const n = periodicNoise(x, y, size, 3.2);
  const grain = (hash2(x, y, 91) - 0.5) * 10;
  const value = 220 + n * 18 + grain;
  return [value - 2, value + 2, value - 5];
});

writeTexture('wood-detail.png', 256, (x, y, size) => {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  const grain = Math.sin(u * 9 + Math.sin(v * 2) * 0.8) * 0.55
    + Math.sin(u * 21 + v * 0.7) * 0.18
    + periodicNoise(x, y, size, 5.8) * 0.25;
  const seam = Math.abs(Math.sin(v * 4)) > 0.992 ? -24 : 0;
  const value = 222 + grain * 20 + seam;
  return [value + 5, value, value - 8];
});

writeTexture('metal-detail.png', 256, (x, y, size) => {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  const brushed = Math.sin(u * 37 + Math.sin(v * 3) * 0.4) * 0.23;
  const mottled = periodicNoise(x, y, size, 8.1) * 0.28;
  const scratch = hash2(x >> 2, y, 137) > 0.992 ? 20 : 0;
  const value = 221 + (brushed + mottled) * 18 + scratch;
  return [value - 3, value, value + 3];
});

writeTexture('fabric-detail.png', 256, (x, y, size) => {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  const weave = Math.sin(u * 32) * Math.cos(v * 32) * 0.46;
  const folds = periodicNoise(x, y, size, 10.4) * 0.35;
  const value = 224 + weave * 10 + folds * 13;
  return [value - 2, value, value + 1];
});

writeTexture('concrete-detail.png', 256, (x, y, size) => {
  const n = periodicNoise(x, y, size, 13.7) * 0.7;
  const aggregate = hash2(x >> 1, y >> 1, 211);
  const pore = aggregate > 0.987 ? -25 : aggregate < 0.012 ? 11 : 0;
  const value = 220 + n * 13 + pore;
  return [value + 1, value, value - 2];
});

writeTexture('roof-detail.png', 256, (x, y, size) => {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  const rows = Math.sin(v * 8) * 0.52;
  const stagger = Math.sin(u * 8 + (Math.floor((y / size) * 8) % 2) * Math.PI) * 0.18;
  const weather = periodicNoise(x, y, size, 16.2) * 0.24;
  const seam = Math.abs(Math.sin(v * 8)) > 0.982 ? -23 : 0;
  const value = 220 + (rows + stagger + weather) * 16 + seam;
  return [value + 4, value, value - 5];
});

writeTexture('foliage-detail.png', 256, (x, y, size) => {
  const u = (x / size) * Math.PI * 2;
  const v = (y / size) * Math.PI * 2;
  const veins = Math.sin(u * 19 + Math.sin(v * 4) * 1.4) * 0.26;
  const mottling = periodicNoise(x, y, size, 19.1) * 0.58;
  const speck = hash2(x, y, 277) > 0.986 ? 13 : 0;
  const value = 221 + veins * 9 + mottling * 14 + speck;
  return [value - 3, value + 2, value - 4];
});
copyFileSync(join(SOURCE_DIR, 'stone-material.png'), join(TEXTURE_DIR, 'stone-detail.png'));
copyFileSync(join(SOURCE_DIR, 'painted-metal-material.png'), join(TEXTURE_DIR, 'painted-metal-detail.png'));

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function writeWav(name, duration, synth, seed) {
  const count = Math.ceil(duration * SAMPLE_RATE);
  const samples = new Float32Array(count);
  const random = seeded(seed);
  const state = { low: 0, low2: 0, last: 0 };
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const value = synth(i / SAMPLE_RATE, i, random, state);
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  const scale = peak > 0 ? 0.88 / peak : 1;
  const dataBytes = count * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < count; i++) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * scale)) * 32767), 44 + i * 2);
  }
  writeFileSync(join(AUDIO_DIR, name), wav);
  return { file: name, duration, bytes: wav.length };
}

function noise(random) {
  return random() * 2 - 1;
}

function gunshot({ body, crack, decay, tail = 0.18 }) {
  return (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.08;
    state.low2 += (state.low - state.low2) * 0.1;
    const transient = Math.exp(-t * decay);
    const pressure = Math.sin(Math.PI * 2 * (body * t - body * t * t * 1.6)) * Math.exp(-t * 18);
    const high = (white - state.low) * Math.exp(-t * crack);
    const room = state.low2 * Math.exp(-t / tail);
    return pressure * 0.75 + high * 0.58 * transient + room * 0.34;
  };
}

function footstep({ body, grit, ring = 0, splash = 0 }) {
  return (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * (0.07 + grit * 0.06);
    state.low2 += (state.low - state.low2) * 0.12;
    const attack = 1 - Math.exp(-t * 120);
    const envelope = attack * Math.exp(-t * (22 - splash * 12));
    const sole = Math.sin(Math.PI * 2 * (body - t * body * 0.8) * t) * Math.exp(-t * 34);
    const granular = (white - state.low) * envelope * grit;
    const resonance = Math.sin(Math.PI * 2 * ring * t) * Math.exp(-t * 22) * (ring > 0 ? 0.28 : 0);
    const water = (white - state.low2) * Math.exp(-t * 9) * splash;
    return sole * 0.52 + state.low2 * envelope * 0.72 + granular * 0.44 + resonance + water * 0.58;
  };
}

function loopEnvelope(t, duration) {
  return Math.min(1, t * 8, (duration - t) * 8);
}

const audioManifest = [
  writeWav('shot-pistol.wav', 0.24, gunshot({ body: 170, crack: 28, decay: 20 }), 11),
  writeWav('shot-rifle.wav', 0.34, gunshot({ body: 125, crack: 22, decay: 15, tail: 0.24 }), 12),
  writeWav('shot-akm.wav', 0.4, gunshot({ body: 98, crack: 18, decay: 12, tail: 0.3 }), 13),
  writeWav('shot-smg.wav', 0.2, gunshot({ body: 205, crack: 34, decay: 24 }), 14),
  writeWav('shot-dmr.wav', 0.46, gunshot({ body: 88, crack: 16, decay: 10, tail: 0.34 }), 15),
  writeWav('shot-sniper.wav', 0.72, gunshot({ body: 62, crack: 12, decay: 8, tail: 0.52 }), 16),
  writeWav('shot-shotgun.wav', 0.58, gunshot({ body: 54, crack: 14, decay: 9, tail: 0.46 }), 17),
  writeWav('shot-suppressed.wav', 0.18, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.22;
    return (white - state.low) * Math.exp(-t * 42) * 0.52
      + Math.sin(Math.PI * 2 * 170 * t) * Math.exp(-t * 35) * 0.32;
  }, 18),
  writeWav('impact-body.wav', 0.16, (t, _i, random, state) => {
    state.low += (noise(random) - state.low) * 0.12;
    return state.low * Math.exp(-t * 28) + Math.sin(Math.PI * 2 * 118 * t) * Math.exp(-t * 36) * 0.45;
  }, 21),
  writeWav('impact-head.wav', 0.18, (t, _i, random, state) => {
    const ring = Math.sin(Math.PI * 2 * 1180 * t) * Math.exp(-t * 24);
    state.low += (noise(random) - state.low) * 0.3;
    return ring * 0.5 + (noise(random) - state.low) * Math.exp(-t * 40) * 0.35;
  }, 22),
  writeWav('impact-wood.wav', 0.24, (t, _i, random, state) => {
    state.low += (noise(random) - state.low) * 0.09;
    return state.low * Math.exp(-t * 18) + Math.sin(Math.PI * 2 * 145 * t) * Math.exp(-t * 26) * 0.5;
  }, 23),
  writeWav('impact-glass.wav', 0.42, (t, _i, random) => {
    const shards = Math.sin(Math.PI * 2 * (2100 + 950 * Math.sin(t * 31)) * t);
    return shards * Math.exp(-t * 12) * (0.35 + random() * 0.25) + noise(random) * Math.exp(-t * 24) * 0.2;
  }, 24),
  writeWav('impact-metal.wav', 0.3, (t, _i, random) => (
    Math.sin(Math.PI * 2 * 760 * t) * Math.exp(-t * 14) * 0.55
    + Math.sin(Math.PI * 2 * 1320 * t) * Math.exp(-t * 22) * 0.3
    + noise(random) * Math.exp(-t * 35) * 0.15
  ), 25),
  writeWav('explosion-frag.wav', 0.9, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.035;
    state.low2 += (state.low - state.low2) * 0.08;
    return state.low2 * Math.exp(-t * 3.5) * 1.2
      + (white - state.low) * Math.exp(-t * 10) * 0.45
      + Math.sin(Math.PI * 2 * (58 - t * 20) * t) * Math.exp(-t * 4.5) * 0.7;
  }, 31),
  writeWav('explosion-artillery.wav', 1.25, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.024;
    state.low2 += (state.low - state.low2) * 0.055;
    return state.low2 * Math.exp(-t * 2.4) * 1.35
      + (white - state.low) * Math.exp(-t * 7) * 0.38
      + Math.sin(Math.PI * 2 * (44 - t * 12) * t) * Math.exp(-t * 3.2) * 0.82;
  }, 32),
  writeWav('ui-pickup.wav', 0.2, (t) => (
    Math.sin(Math.PI * 2 * (520 + t * 1750) * t) * Math.exp(-t * 18) * 0.6
    + Math.sin(Math.PI * 2 * 960 * t) * Math.exp(-t * 25) * 0.25
  ), 41),
  writeWav('action-reload.wav', 0.34, (t, _i, random) => {
    const clickA = Math.exp(-Math.abs(t - 0.025) * 90);
    const clickB = Math.exp(-Math.abs(t - 0.22) * 110);
    return noise(random) * (clickA + clickB * 0.8) * 0.38
      + Math.sin(Math.PI * 2 * 240 * t) * clickB * 0.28;
  }, 42),
  writeWav('movement-footstep.wav', 0.14, (t, _i, random, state) => {
    state.low += (noise(random) - state.low) * 0.08;
    return state.low * Math.exp(-t * 34)
      + Math.sin(Math.PI * 2 * 92 * t) * Math.exp(-t * 42) * 0.38;
  }, 43),
  writeWav('movement-footstep-grass-a.wav', 0.18, footstep({ body: 82, grit: 0.72 }), 101),
  writeWav('movement-footstep-grass-b.wav', 0.19, footstep({ body: 76, grit: 0.82 }), 102),
  writeWav('movement-footstep-dirt-a.wav', 0.17, footstep({ body: 94, grit: 0.48 }), 103),
  writeWav('movement-footstep-dirt-b.wav', 0.18, footstep({ body: 88, grit: 0.58 }), 104),
  writeWav('movement-footstep-wood-a.wav', 0.2, footstep({ body: 118, grit: 0.24, ring: 420 }), 105),
  writeWav('movement-footstep-wood-b.wav', 0.21, footstep({ body: 108, grit: 0.3, ring: 360 }), 106),
  writeWav('movement-footstep-stone-a.wav', 0.18, footstep({ body: 138, grit: 0.2, ring: 720 }), 107),
  writeWav('movement-footstep-stone-b.wav', 0.19, footstep({ body: 126, grit: 0.24, ring: 630 }), 108),
  writeWav('movement-footstep-metal-a.wav', 0.22, footstep({ body: 152, grit: 0.16, ring: 1080 }), 109),
  writeWav('movement-footstep-metal-b.wav', 0.23, footstep({ body: 144, grit: 0.2, ring: 920 }), 110),
  writeWav('movement-footstep-water-a.wav', 0.27, footstep({ body: 72, grit: 0.32, splash: 0.92 }), 111),
  writeWav('movement-footstep-water-b.wav', 0.29, footstep({ body: 66, grit: 0.38, splash: 1 }), 112),
  writeWav('movement-splash.wav', 0.46, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.035;
    state.low2 += (state.low - state.low2) * 0.07;
    const attack = Math.min(1, t / 0.045);
    const wash = (state.low - state.low2) * Math.exp(-t * 4.8) * 0.9;
    const body = Math.sin(Math.PI * 2 * (78 - t * 20) * t) * Math.exp(-t * 7) * 0.18;
    const bubbles = Math.sin(Math.PI * 2 * (210 + t * 150) * t) * Math.exp(-t * 10) * 0.08;
    return (wash + body + bubbles) * attack;
  }, 44),
  writeWav('action-door.wav', 0.48, (t, _i, random) => {
    const creak = Math.sin(Math.PI * 2 * (145 + t * 130) * t + Math.sin(t * 68) * 0.8);
    const latch = Math.exp(-Math.abs(t - 0.41) * 80);
    return creak * Math.sin(Math.PI * Math.min(1, t / 0.45)) * 0.42
      + noise(random) * latch * 0.25;
  }, 45),
  writeWav('environment-wind.wav', 1.5, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.018;
    state.low2 += (state.low - state.low2) * 0.035;
    const gust = 0.42 + Math.sin(t * Math.PI * 2 / 1.5) * 0.18
      + Math.sin(t * Math.PI * 4 / 1.5 + 1.1) * 0.09;
    return state.low2 * gust * loopEnvelope(t, 1.5);
  }, 121),
  writeWav('environment-forest.wav', 1.5, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.05;
    const leaves = (white - state.low) * (0.16 + Math.sin(t * Math.PI * 2 / 1.5) * 0.05);
    const bird = Math.sin(Math.PI * 2 * (1450 + Math.sin(t * 7) * 180) * t)
      * Math.max(0, Math.sin(t * Math.PI * 4 / 1.5)) ** 10 * 0.16;
    return (leaves + bird) * loopEnvelope(t, 1.5);
  }, 122),
  writeWav('environment-coast.wav', 1.5, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.075;
    state.low2 += (state.low - state.low2) * 0.05;
    const wave = Math.max(0, Math.sin(t * Math.PI * 2 / 1.5 - 0.5));
    return ((white - state.low) * 0.14 + state.low2 * 0.62) * (0.28 + wave * 0.72)
      * loopEnvelope(t, 1.5);
  }, 123),
  writeWav('environment-rain.wav', 1.5, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.2;
    const hiss = white - state.low;
    const drops = random() > 0.985 ? (random() - 0.5) * 1.2 : 0;
    return (hiss * 0.42 + drops) * loopEnvelope(t, 1.5);
  }, 124),
  writeWav('shot-tail-open.wav', 0.72, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.035;
    return state.low * Math.exp(-t * 4.2) * 0.54
      + Math.sin(Math.PI * 2 * 92 * t) * Math.exp(-t * 5.4) * 0.22;
  }, 131),
  writeWav('shot-tail-forest.wav', 0.52, (t, _i, random, state) => {
    const white = noise(random);
    state.low += (white - state.low) * 0.075;
    return state.low * Math.exp(-t * 7.2) * 0.44
      + (white - state.low) * Math.exp(-t * 11) * 0.12;
  }, 132),
  writeWav('shot-tail-indoor.wav', 0.64, (t, _i, random) => {
    const slapA = Math.sin(Math.PI * 2 * 182 * t) * Math.exp(-t * 7.5);
    const slapB = Math.sin(Math.PI * 2 * 244 * Math.max(0, t - 0.055))
      * Math.exp(-Math.max(0, t - 0.055) * 9.5);
    return (slapA * 0.5 + slapB * 0.34 + noise(random) * Math.exp(-t * 12) * 0.12)
      * (1 - Math.exp(-t * 80));
  }, 133),
];

writeFileSync(
  join(AUDIO_DIR, 'manifest.json'),
  `${JSON.stringify({ sampleRate: SAMPLE_RATE, files: audioManifest }, null, 2)}\n`,
);

console.log(`Generated 10 textures and ${audioManifest.length} audio assets.`);
