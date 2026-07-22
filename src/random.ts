let seededRandom: (() => number) | null = null;
let activeSeed: number | null = null;

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function setRandomSeed(seed: number | null): void {
  activeSeed = seed === null ? null : seed >>> 0;
  seededRandom = activeSeed === null ? null : createSeededRandom(activeSeed);
}

export function random(): number {
  return seededRandom ? seededRandom() : Math.random();
}

export function currentRandomSeed(): number | null {
  return activeSeed;
}

export function parseRandomSeed(search: string, fallback: number | null = null): number | null {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) >>> 0 : fallback;
}
