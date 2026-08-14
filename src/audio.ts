// WebAudio 静态采样资产 + 程序合成降级。循环环境声继续实时生成，关键反馈优先使用 WAV。
import type { WeaponId } from './types';
import { clamp } from './utils';
import {
  AUDIO_ASSET_URLS,
  FOOTSTEP_ASSET_IDS,
  shotAssetId,
  type AudioAssetId,
  type FootstepSurface,
} from './assets';
import { shotAcousticMix, WEAPON_PRESENTATION } from './combatpresentation';

export type AmbienceBiome = 'open' | 'forest' | 'coast';
export type AcousticSpace = 'indoor' | 'open' | 'forest';

export interface AmbienceMix {
  wind: number;
  forest: number;
  coast: number;
  rain: number;
}

export interface FootstepDistanceProfile {
  readonly gain: number;
  readonly lowpassHz: number;
  readonly delaySeconds: number;
}

export function footstepDistanceProfile(distance: number, occluded = false): FootstepDistanceProfile {
  const d = Math.max(0, distance);
  const far = clamp(d / 36, 0, 1);
  const baseGain = clamp(1 / (1 + Math.pow(d / 8.5, 1.9)), 0.008, 1);
  const baseLowpass = Math.round(7200 * (1 - far) + 900 * far);
  return {
    gain: baseGain * (occluded ? 0.34 : 1),
    lowpassHz: occluded ? Math.min(1250, baseLowpass) : baseLowpass,
    delaySeconds: d <= 2 ? 0 : Math.min(0.11, (d - 2) / 343),
  };
}

export interface ShortRangeSoundProfile {
  readonly gain: number;
  readonly lowpassHz: number;
  readonly delaySeconds: number;
}

export function meleeDistanceProfile(distance: number, occluded = false): ShortRangeSoundProfile {
  const d = Math.max(0, distance);
  const maxDistance = 11;
  if (d >= maxDistance) return { gain: 0, lowpassHz: 700, delaySeconds: 0 };
  const edge = Math.pow(1 - d / maxDistance, 1.55);
  const gain = edge / (1 + Math.pow(d / 2.65, 2.15));
  const far = d / maxDistance;
  const lowpassHz = Math.round(5400 * (1 - far) + 850 * far);
  return {
    gain: gain * (occluded ? 0.28 : 1),
    lowpassHz: occluded ? Math.min(1050, lowpassHz) : lowpassHz,
    delaySeconds: d <= 1.5 ? 0 : Math.min(0.032, (d - 1.5) / 343),
  };
}

export function motionWhooshDistanceProfile(distance: number, occluded = false): ShortRangeSoundProfile {
  const d = Math.max(0, distance);
  const maxDistance = 8;
  if (d >= maxDistance) return { gain: 0, lowpassHz: 650, delaySeconds: 0 };
  const edge = Math.pow(1 - d / maxDistance, 1.7);
  const gain = edge / (1 + Math.pow(d / 2.2, 2.2));
  const far = d / maxDistance;
  const lowpassHz = Math.round(4600 * (1 - far) + 800 * far);
  return {
    gain: gain * (occluded ? 0.25 : 1),
    lowpassHz: occluded ? Math.min(950, lowpassHz) : lowpassHz,
    delaySeconds: d <= 1.5 ? 0 : Math.min(0.024, (d - 1.5) / 343),
  };
}

export function ambienceMix(
  rain: number,
  daylight: number,
  biome: AmbienceBiome,
  sheltered: boolean,
): AmbienceMix {
  const rain01 = clamp(rain, 0, 1);
  const day01 = clamp(daylight, 0, 1);
  const outdoor = sheltered ? 0.34 : 1;
  const nightLift = 1 + (1 - day01) * 0.18;
  return {
    wind: (0.012 + rain01 * 0.032) * outdoor * nightLift,
    forest: biome === 'forest' ? 0.035 * outdoor * day01 : 0,
    coast: biome === 'coast' ? 0.042 * outdoor : 0,
    rain: rain01 * (sheltered ? 0.052 : 0.082),
  };
}

export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private rainLevel = 0;
  private daylightLevel = 1;
  private ambienceBiome: AmbienceBiome = 'open';
  private ambienceSheltered = false;
  private ambienceLoops = new Map<AudioAssetId, { source: AudioBufferSourceNode; gain: GainNode }>();
  private samples = new Map<AudioAssetId, AudioBuffer>();
  private sampleLoadStarted = false;
  private readonly publishTestState = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('test');
  muted = false;

  constructor() {
    try {
      this.muted = window.localStorage.getItem('web-pubg-muted') === '1';
    } catch {
      this.muted = false;
    }
    this.publishMutedState();
  }

  // 必须在用户手势中调用
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -12;
      this.limiter.knee.value = 8;
      this.limiter.ratio.value = 6;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.18;
      this.master.connect(this.limiter).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.loadAssetSamples();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.rainLevel > 0.01) this.ensureRainLoop();
  }

  toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  setMuted(muted: boolean): boolean {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
    }
    try {
      window.localStorage.setItem('web-pubg-muted', this.muted ? '1' : '0');
    } catch {
      // 隐私模式或禁用存储时仍保持本次会话状态.
    }
    this.publishMutedState();
    return this.muted;
  }

  private publishMutedState(): void {
    if (typeof document !== 'undefined') document.body.dataset.audioMuted = String(this.muted);
  }

  private out(pan: number): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    if (Math.abs(pan) < 0.01) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master);
    return p;
  }

  private async loadAssetSamples(): Promise<void> {
    if (this.sampleLoadStarted || !this.ctx) return;
    this.sampleLoadStarted = true;
    const ctx = this.ctx;
    const entries = Object.entries(AUDIO_ASSET_URLS) as [AudioAssetId, string][];
    let errors = 0;
    await Promise.all(entries.map(async ([id, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        if (this.ctx === ctx) this.samples.set(id, buffer);
      } catch {
        errors++;
      }
    }));
    this.syncAmbience();
    if (typeof document !== 'undefined') {
      document.body.dataset.audioAssetsLoaded = `${this.samples.size}/${entries.length}`;
      document.body.dataset.audioAssetErrors = String(errors);
    }
  }

  private playAsset(
    id: AudioAssetId,
    volume: number,
    pan: number,
    rate = 1,
    spatial?: { lowpassHz: number; delaySeconds: number },
  ): boolean {
    if (!this.ctx) return false;
    const buffer = this.samples.get(id);
    const dst = this.out(pan);
    if (!buffer || !dst) return false;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(rate, 0.72, 1.28);
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0.001, volume);
    if (spatial && spatial.lowpassHz < 19000) {
      const lowpass = this.ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = clamp(spatial.lowpassHz, 500, 19000);
      lowpass.Q.value = 0.58;
      source.connect(lowpass).connect(gain).connect(dst);
    } else {
      source.connect(gain).connect(dst);
    }
    source.start(this.ctx.currentTime + Math.max(0, spatial?.delaySeconds ?? 0));
    if (this.publishTestState) {
      document.body.dataset.lastAudioAsset = id;
      if (spatial) {
        document.body.dataset.lastAudioLowpass = String(Math.round(spatial.lowpassHz));
        document.body.dataset.lastAudioDelayMs = String(Math.round(spatial.delaySeconds * 1000));
      }
      document.body.dataset.audioAssetPlays = String(
        Number(document.body.dataset.audioAssetPlays ?? 0) + 1,
      );
    }
    return true;
  }

  private ensureRainLoop(): void {
    if (!this.ctx || !this.master || !this.noiseBuf || this.rainSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6200;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(lp).connect(gain).connect(this.master);
    src.start();
    this.rainSource = src;
    this.rainGain = gain;
  }

  setRain(level: number): void {
    this.rainLevel = clamp(level, 0, 1);
    this.syncAmbience();
  }

  setEnvironmentAmbience(
    rain: number,
    daylight: number,
    biome: AmbienceBiome,
    sheltered: boolean,
  ): void {
    this.rainLevel = clamp(rain, 0, 1);
    this.daylightLevel = clamp(daylight, 0, 1);
    this.ambienceBiome = biome;
    this.ambienceSheltered = sheltered;
    this.syncAmbience();
  }

  private ensureAmbienceLoop(id: AudioAssetId): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const active = this.ambienceLoops.get(id);
    if (active) return active.gain;
    const buffer = this.samples.get(id);
    if (!buffer) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.master);
    source.start();
    this.ambienceLoops.set(id, { source, gain });
    return gain;
  }

  private syncAmbience(): void {
    if (!this.ctx) return;
    const mix = ambienceMix(
      this.rainLevel,
      this.daylightLevel,
      this.ambienceBiome,
      this.ambienceSheltered,
    );
    const targets: readonly [AudioAssetId, number][] = [
      ['environment-wind', mix.wind],
      ['environment-forest', mix.forest],
      ['environment-coast', mix.coast],
      ['environment-rain', mix.rain],
    ];
    let hasRainSample = false;
    for (const [id, target] of targets) {
      const gain = this.ensureAmbienceLoop(id);
      if (!gain) continue;
      if (id === 'environment-rain') hasRainSample = true;
      gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.45);
    }
    // 正式采样尚未解码时保留程序雨声，加载完成后平滑交棒给环境采样。
    if (!hasRainSample && this.rainLevel > 0.01) this.ensureRainLoop();
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(
        hasRainSample ? 0 : this.rainLevel * 0.085,
        this.ctx.currentTime,
        0.35,
      );
    }
  }

  thunder(): void {
    this.noiseBurst(0.72, 0, 115, 0.3, 0.85);
    this.thump(0.68, 0, 72, 24, 0.7);
    window.setTimeout(() => this.noiseBurst(0.28, 0, 180, 0.4, 0.65), 180);
  }

  // 噪声爆发: 枪声主体
  private noiseBurst(
    vol: number, pan: number, freq: number, q: number, dur: number,
    spatial?: { lowpassHz: number; delaySeconds: number },
  ): void {
    if (!this.ctx || !this.noiseBuf) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime + Math.max(0, spatial?.delaySeconds ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    if (spatial && spatial.lowpassHz < 19000) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(spatial.lowpassHz, 500, 19000);
      bp.connect(lp).connect(g).connect(dst);
      src.connect(bp);
    } else {
      src.connect(bp).connect(g).connect(dst);
    }
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // 低频体音: 枪声"砰"感
  private thump(
    vol: number, pan: number, f0: number, f1: number, dur: number,
    spatial?: { lowpassHz: number; delaySeconds: number },
  ): void {
    if (!this.ctx) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime + Math.max(0, spatial?.delaySeconds ?? 0);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    if (spatial && spatial.lowpassHz < 19000) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(spatial.lowpassHz, 500, 19000);
      o.connect(lp).connect(g).connect(dst);
    } else {
      o.connect(g).connect(dst);
    }
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private blip(f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const dst = this.out(0);
    if (!dst) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dst);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // dist: 与听者距离, pan: 相对左右(-1..1)
  shot(
    kind: WeaponId,
    dist: number,
    pan: number,
    suppressed = false,
    space: AcousticSpace = 'open',
    occluded = false,
  ): void {
    if (!this.ctx) return;
    const mix = shotAcousticMix(kind, dist, suppressed, space, Math.random() * 2 - 1);
    const occlusionGain = occluded ? (suppressed ? 0.24 : 0.36) : 1;
    const bodyGain = mix.bodyGain * occlusionGain;
    const mechanismGain = mix.mechanismGain * (occluded ? 0.22 : 1);
    const tailGain = mix.tailGain * (occluded ? 0.18 : 1);
    const lowpassHz = occluded ? Math.min(1250, mix.lowpassHz) : mix.lowpassHz;
    const distanceAtt = bodyGain / Math.max(WEAPON_PRESENTATION[kind].sampleGain, 0.001);
    const att = distanceAtt * (suppressed ? 0.24 : 1);
    const presentation = WEAPON_PRESENTATION[kind];
    if (mechanismGain > 0.001) {
      this.noiseBurst(mechanismGain, pan, presentation.mechanismFrequency, 2.2, 0.032, {
        lowpassHz,
        delaySeconds: mix.delaySeconds,
      });
    }
    const spatial = { lowpassHz, delaySeconds: mix.delaySeconds };
    if (this.playAsset(shotAssetId(kind, suppressed), bodyGain, pan, mix.playbackRate, spatial)) {
      if (tailGain > 0) {
        this.playAsset(`shot-tail-${space}`, tailGain, pan * 0.58, 0.97 + Math.random() * 0.06, {
          lowpassHz: Math.min(10500, lowpassHz * 1.45),
          delaySeconds: mix.delaySeconds + (space === 'indoor' ? 0.035 : 0.075),
        });
      }
      return;
    }
    if (suppressed) this.noiseBurst(0.08 * distanceAtt, pan, 2400, 1.5, 0.045, spatial);
    switch (kind) {
      case 'pistol':
        this.noiseBurst(0.5 * att, pan, 1100, 0.9, 0.11, spatial);
        this.thump(0.35 * att, pan, 240, 70, 0.09, spatial);
        break;
      case 'rifle':
        this.noiseBurst(0.6 * att, pan, 750, 0.7, 0.15, spatial);
        this.thump(0.45 * att, pan, 190, 55, 0.13, spatial);
        break;
      case 'akm':
        this.noiseBurst(0.68 * att, pan, 620, 0.68, 0.18, spatial);
        this.thump(0.52 * att, pan, 165, 48, 0.16, spatial);
        break;
      case 'lmg':
        this.noiseBurst(0.72 * att, pan, 560, 0.62, 0.2, spatial);
        this.thump(0.55 * att, pan, 150, 42, 0.18, spatial);
        break;
      case 'smg':
        this.noiseBurst(0.42 * att, pan, 1400, 1.1, 0.08, spatial);
        this.thump(0.25 * att, pan, 260, 90, 0.06, spatial);
        break;
      case 'dmr':
        this.noiseBurst(0.7 * att, pan, 560, 0.58, 0.22, spatial);
        this.thump(0.52 * att, pan, 155, 44, 0.2, spatial);
        break;
      case 'sniper':
        this.noiseBurst(0.85 * att, pan, 420, 0.5, 0.38, spatial);
        this.thump(0.6 * att, pan, 130, 38, 0.32, spatial);
        break;
      case 'shotgun':
        // 霰弹: 低沉轰响(比步枪更低频更厚)
        this.noiseBurst(0.75 * att, pan, 380, 0.6, 0.3, spatial);
        this.thump(0.6 * att, pan, 120, 30, 0.3, spatial);
        break;
    }
  }

  bulletWhiz(pan: number): void {
    this.noiseBurst(0.2, pan, 3600, 1.35, 0.11);
    this.thump(0.055, pan, 520, 180, 0.07);
  }

  flashbang(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.055), 0.04, 1);
    this.noiseBurst(0.66 * att, pan, 2200, 0.75, 0.09);
    this.thump(0.34 * att, pan, 260, 70, 0.08);
    this.blip(2800, 1350, 0.22, 0.17 * att, 'sine');
  }

  hit(head: boolean): void {
    if (this.playAsset(head ? 'impact-head' : 'impact-body', head ? 0.42 : 0.36, 0, 0.97 + Math.random() * 0.06)) return;
    this.noiseBurst(0.4, 0, head ? 2600 : 320, 1.2, 0.06);
    if (head) this.blip(1400, 900, 0.06, 0.18, 'square');
  }

  kill(): void {
    this.blip(660, 660, 0.07, 0.22, 'sine');
    window.setTimeout(() => this.blip(880, 880, 0.12, 0.22, 'sine'), 80);
  }

  pickup(): void {
    if (this.playAsset('ui-pickup', 0.24, 0)) return;
    this.blip(520, 820, 0.08, 0.2, 'square');
  }

  reload(): void {
    if (this.playAsset('action-reload', 0.34, 0, 0.98 + Math.random() * 0.04)) return;
    this.blip(300, 180, 0.05, 0.15, 'square');
    window.setTimeout(() => this.blip(420, 300, 0.05, 0.15, 'square'), 160);
  }

  equip(): void {
    this.noiseBurst(0.08, 0, 1800, 0.9, 0.06);
    this.blip(420, 300, 0.045, 0.11, 'square');
  }

  // 双管霰弹装填: 开膛 + 两次塞弹 + 合膛(对位 2.6s 装填)
  reloadShotgun(): void {
    this.blip(260, 180, 0.06, 0.16, 'square'); // 开膛
    window.setTimeout(() => this.blip(520, 380, 0.04, 0.18, 'square'), 700);  // 第一发
    window.setTimeout(() => this.blip(520, 380, 0.04, 0.18, 'square'), 1600); // 第二发
    window.setTimeout(() => this.blip(340, 260, 0.06, 0.18, 'square'), 2300); // 合膛
  }

  empty(): void {
    this.blip(900, 700, 0.04, 0.12, 'square');
  }

  zoneTick(): void {
    this.blip(440, 430, 0.07, 0.12, 'sine');
  }

  // 近战挥击(风声): 噪声经带通高频→低频快速下扫, 软起音 -- 与枪声的短促爆音区分
  melee(dist: number, pan: number, occluded = false): void {
    if (!this.ctx || !this.noiseBuf) return;
    const profile = meleeDistanceProfile(dist, occluded);
    if (profile.gain <= 0.001) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime + profile.delaySeconds;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.15;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.16);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = profile.lowpassHz;
    lp.Q.value = 0.55;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * profile.gain, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    src.connect(bp).connect(lp).connect(g).connect(dst);
    src.start(t);
    src.stop(t + 0.24);
    if (this.publishTestState) {
      document.body.dataset.lastSpatialSound = 'melee';
      document.body.dataset.lastSpatialGain = profile.gain.toFixed(3);
      document.body.dataset.lastSpatialLowpass = String(profile.lowpassHz);
    }
  }

  // 老虎近身扑咬: 短促低频吼声与重击叠加, 并按距离和遮挡衰减。
  tigerAttack(dist: number, pan: number, occluded = false): void {
    if (!this.ctx) return;
    const d = Math.max(0, dist);
    if (d >= 18) return;
    const edge = Math.pow(1 - d / 18, 1.35);
    const gain = edge / (1 + Math.pow(d / 5.2, 1.8)) * (occluded ? 0.34 : 1);
    if (gain <= 0.001) return;
    const lowpass = occluded ? 760 : Math.round(2200 - Math.min(1, d / 18) * 1200);
    this.thump(0.34 * gain, pan, 118, 48, 0.16);
    this.noiseBurst(0.16 * gain, pan, lowpass, 0.62, 0.2);
    this.blip(150, 72, 0.18, 0.14 * gain, 'sawtooth');
    if (this.publishTestState) {
      document.body.dataset.lastSpatialSound = 'tiger';
      document.body.dataset.lastSpatialGain = gain.toFixed(3);
      document.body.dataset.lastSpatialLowpass = String(lowpass);
    }
  }

  // 鳄鱼近身撕咬: 更低沉的闭合冲击叠加水花，保持与老虎吼声可辨识。
  crocodileAttack(dist: number, pan: number, occluded = false): void {
    if (!this.ctx) return;
    const d = Math.max(0, dist);
    if (d >= 18) return;
    const edge = Math.pow(1 - d / 18, 1.4);
    const gain = edge / (1 + Math.pow(d / 5, 1.85)) * (occluded ? 0.34 : 1);
    if (gain <= 0.001) return;
    const lowpass = occluded ? 680 : Math.round(1800 - Math.min(1, d / 18) * 980);
    this.thump(0.38 * gain, pan, 92, 38, 0.14);
    this.noiseBurst(0.19 * gain, pan, lowpass, 0.48, 0.16);
    this.blip(106, 54, 0.15, 0.11 * gain, 'square');
    if (this.publishTestState) {
      document.body.dataset.lastSpatialSound = 'crocodile';
      document.body.dataset.lastSpatialGain = gain.toFixed(3);
      document.body.dataset.lastSpatialLowpass = String(lowpass);
    }
  }

  motionWhoosh(dist: number, pan: number, kind: 'throw' | 'vault', occluded = false): void {
    const profile = motionWhooshDistanceProfile(dist, occluded);
    if (profile.gain <= 0.001) return;
    const volume = kind === 'throw' ? 0.095 : 0.075;
    const frequency = kind === 'throw' ? 1850 : 1250;
    this.noiseBurst(volume * profile.gain, pan, frequency, 1.15, kind === 'throw' ? 0.13 : 0.1, profile);
    if (this.publishTestState) {
      document.body.dataset.lastSpatialSound = kind;
      document.body.dataset.lastSpatialGain = profile.gain.toFixed(3);
      document.body.dataset.lastSpatialLowpass = String(profile.lowpassHz);
    }
  }

  // 木质命中(门未被打破)
  woodHit(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    if (this.playAsset('impact-wood', 0.46 * att, pan, 0.94 + Math.random() * 0.1)) return;
    this.noiseBurst(0.42 * att, pan, 320, 1.0, 0.08);
    this.thump(0.3 * att, pan, 150, 70, 0.07);
  }

  // 门板破碎
  woodBreak(dist: number, pan: number): void {
    const att = clamp(1.3 / (1 + dist * 0.028), 0.02, 1);
    if (this.playAsset('impact-wood', 0.72 * att, pan, 0.74)) return;
    this.noiseBurst(0.55 * att, pan, 520, 0.7, 0.22);
    this.thump(0.4 * att, pan, 170, 55, 0.18);
  }

  // 玻璃命中(未碎)
  glassHit(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    if (this.playAsset('impact-glass', 0.28 * att, pan, 1.18)) return;
    this.noiseBurst(0.34 * att, pan, 3200, 2.0, 0.06);
  }

  // 玻璃破碎
  glassBreak(dist: number, pan: number): void {
    const att = clamp(1.3 / (1 + dist * 0.028), 0.02, 1);
    if (this.playAsset('impact-glass', 0.62 * att, pan, 0.94 + Math.random() * 0.08)) return;
    this.noiseBurst(0.5 * att, pan, 2600, 1.2, 0.24);
    this.noiseBurst(0.3 * att, pan, 4300, 2.5, 0.3);
  }

  // 护甲碎裂: 金属崩裂声
  armorBreak(dist: number, pan: number): void {
    const att = clamp(1.4 / (1 + dist * 0.03), 0.02, 1);
    if (this.playAsset('impact-metal', 0.58 * att, pan, 0.86)) return;
    this.noiseBurst(0.5 * att, pan, 2400, 1.4, 0.18);
    this.noiseBurst(0.3 * att, pan, 3600, 2.2, 0.22);
    this.thump(0.3 * att, pan, 200, 90, 0.12);
  }

  // 手雷爆炸: 低频轰 + 噪声
  explosion(dist: number, pan: number): void {
    const att = clamp(2.4 / (1 + dist * 0.018), 0.02, 1);
    if (this.playAsset('explosion-frag', 0.82 * att, pan, 0.96 + Math.random() * 0.05)) return;
    this.noiseBurst(1.0 * att, pan, 160, 0.35, 0.55);
    this.thump(0.9 * att, pan, 85, 24, 0.5);
  }

  // 炮弹下坠: 高频快速下扫, 与子弹和载具声音区分
  artilleryWhistle(dist: number, pan: number): void {
    if (!this.ctx) return;
    const dst = this.out(pan);
    if (!dst) return;
    const att = clamp(1.6 / (1 + dist * 0.028), 0.015, 1);
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1450, t);
    osc.frequency.exponentialRampToValueAtTime(170, t + 0.78);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.08 * att, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    osc.connect(gain).connect(dst);
    osc.start(t);
    osc.stop(t + 0.82);
  }

  // 炮击比手雷更厚, 叠加低频冲击与中频泥土爆裂
  artilleryImpact(dist: number, pan: number): void {
    const att = clamp(2.8 / (1 + dist * 0.016), 0.02, 1);
    if (this.playAsset('explosion-artillery', 0.88 * att, pan, 0.94 + Math.random() * 0.04)) return;
    this.noiseBurst(1.0 * att, pan, 125, 0.3, 0.72);
    this.noiseBurst(0.55 * att, pan, 620, 0.65, 0.34);
    this.thump(1.0 * att, pan, 72, 20, 0.62);
  }

  // 烟雾弹起烟嘶嘶声
  hiss(dist: number, pan: number): void {
    const att = clamp(1.2 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.3 * att, pan, 5200, 0.6, 1.4);
  }

  // 门轴吱呀: 开门升调, 关门降调; 锯齿波 + 11Hz 颤音模拟干涩门轴
  creak(dist: number, pan: number, open: boolean): void {
    if (!this.ctx) return;
    const att = clamp(1.5 / (1 + dist * 0.035), 0.02, 1);
    if (this.playAsset('action-door', 0.36 * att, pan, open ? 1 : 0.82)) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime;
    const dur = 0.45;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(open ? 150 : 230, t);
    o.frequency.exponentialRampToValueAtTime(open ? 260 : 120, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 11;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(o.frequency);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * att, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(dst);
    o.start(t);
    o.stop(t + dur + 0.02);
    lfo.start(t);
    lfo.stop(t + dur + 0.02);
    // 关门末尾一声轻磕
    if (!open) this.thump(0.25 * att, pan, 140, 70, 0.08);
  }

  // 医疗包扎完成
  heal(): void {
    this.blip(360, 540, 0.16, 0.18, 'sine');
    window.setTimeout(() => this.blip(540, 720, 0.14, 0.15, 'sine'), 140);
  }

  // 一次性医疗包完成: 清脆两声提示音
  medkitDone(): void {
    this.blip(880, 880, 0.07, 0.2, 'square');
    window.setTimeout(() => this.blip(1320, 1320, 0.11, 0.2, 'square'), 110);
  }

  // 饮料: 两声咕嘟 + 气泡嘶声
  drink(): void {
    this.blip(300, 180, 0.08, 0.22, 'sine');
    window.setTimeout(() => this.blip(340, 200, 0.08, 0.2, 'sine'), 130);
    this.noiseBurst(0.1, 0, 5200, 0.8, 0.5);
  }

  warn(): void {
    this.blip(520, 520, 0.1, 0.16, 'sine');
    window.setTimeout(() => this.blip(520, 520, 0.1, 0.16, 'sine'), 160);
  }

  step(vol = 1, surface: FootstepSurface = 'grass'): void {
    const choices = FOOTSTEP_ASSET_IDS[surface];
    const asset = choices[Math.random() < 0.5 ? 0 : 1];
    if (this.playAsset(asset, 0.13 * vol, 0, 0.92 + Math.random() * 0.16)) return;
    if (this.playAsset('movement-footstep', 0.13 * vol, 0, 0.92 + Math.random() * 0.16)) return;
    this.noiseBurst(0.1 * vol, 0, 240, 0.8, 0.045);
  }

  stepAt(
    dist: number,
    pan: number,
    speed: number,
    surface: FootstepSurface = 'grass',
    occluded = false,
  ): void {
    const profile = footstepDistanceProfile(dist, occluded);
    const pace = clamp((speed - 0.5) / 6.4, 0, 1);
    const choices = FOOTSTEP_ASSET_IDS[surface];
    const asset = choices[Math.random() < 0.5 ? 0 : 1];
    if (this.playAsset(asset, (0.1 + pace * 0.065) * profile.gain, pan, 0.88 + pace * 0.16, profile)) return;
    if (this.playAsset('movement-footstep', (0.1 + pace * 0.065) * profile.gain, pan, 0.88 + pace * 0.16, profile)) return;
    this.noiseBurst((0.085 + pace * 0.065) * profile.gain, pan, 210 + pace * 90, 0.85, 0.045, profile);
  }

  // 入水扑通(玩家)
  splashIn(): void {
    if (this.playAsset('movement-splash', 0.38, 0, 0.88)) return;
    this.noiseBurst(0.24, 0, 320, 0.65, 0.32);
    this.thump(0.1, 0, 95, 50, 0.26);
  }

  // 出水涉水(玩家)
  splashOut(): void {
    if (this.playAsset('movement-splash', 0.26, 0, 1.16)) return;
    this.noiseBurst(0.24, 0, 720, 0.9, 0.18);
  }

  // 他人入水(距离/方位衰减)
  splashAt(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    if (this.playAsset('movement-splash', 0.34 * att, pan, 0.92)) return;
    this.noiseBurst(0.22 * att, pan, 340, 0.68, 0.28);
    this.thump(0.08 * att, pan, 90, 48, 0.22);
  }

  // 划水(玩家, 每 ~1.7m 一次)
  swimStroke(): void {
    if (this.playAsset('movement-splash', 0.12, 0, 1.24)) return;
    this.noiseBurst(0.13, 0, 480, 0.7, 0.15);
  }

  // 他人划水(距离/方位衰减)
  swimStrokeAt(dist: number, pan: number): void {
    const att = clamp(1.1 / (1 + dist * 0.035), 0.015, 1);
    if (this.playAsset('movement-splash', 0.16 * att, pan, 1.24)) return;
    this.noiseBurst(0.2 * att, pan, 480, 0.7, 0.17);
  }

  jumpLand(surface: FootstepSurface = 'grass'): void {
    const choices = FOOTSTEP_ASSET_IDS[surface];
    const asset = choices[Math.random() < 0.5 ? 0 : 1];
    if (this.playAsset(asset, 0.24, 0, 0.76)) return;
    if (this.playAsset('movement-footstep', 0.24, 0, 0.76)) return;
    this.noiseBurst(0.16, 0, 180, 0.8, 0.07);
  }

  // 翻越: 布料窸窣 + 短闷响
  vault(): void {
    this.noiseBurst(0.14, 0, 2600, 0.7, 0.09);
    this.thump(0.2, 0, 220, 90, 0.1);
  }

  // 开伞: 嘭 + 伞布抖动
  canopyDeploy(): void {
    this.thump(0.5, 0, 200, 60, 0.25);
    this.noiseBurst(0.3, 0, 1400, 0.7, 0.3);
  }

  // 车门
  vehicleDoor(): void {
    if (this.playAsset('action-door', 0.34, 0, 0.78)) return;
    this.thump(0.35, 0, 160, 70, 0.12);
  }

  // 载具撞击
  vehicleImpact(dist: number, pan: number): void {
    const att = clamp(1.6 / (1 + dist * 0.03), 0.02, 1);
    if (this.playAsset('impact-metal', 0.62 * att, pan, 0.72)) return;
    this.noiseBurst(0.6 * att, pan, 240, 0.8, 0.22);
    this.thump(0.5 * att, pan, 120, 40, 0.2);
  }

  // 引擎循环(锯齿波 + 低通, 转速随速度)
  private engOsc: OscillatorNode | null = null;
  private engGain: GainNode | null = null;
  engineSet(rpm: number): void {
    if (!this.ctx || !this.master) return;
    if (!this.engOsc) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 70;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      o.connect(lp).connect(g).connect(this.master);
      o.start();
      this.engOsc = o;
      this.engGain = g;
    }
    const t = this.ctx.currentTime;
    this.engOsc.frequency.setTargetAtTime(62 + rpm * 115, t, 0.08);
    (this.engGain as GainNode).gain.setTargetAtTime(0.04 + rpm * 0.055, t, 0.08);
  }

  engineStop(): void {
    if (this.engGain && this.ctx) {
      this.engGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
    const o = this.engOsc;
    this.engOsc = null;
    this.engGain = null;
    if (o) {
      window.setTimeout(() => {
        try {
          o.stop();
        } catch {
          /* 已停止 */
        }
      }, 400);
    }
  }

  // 风声(自由落体/滑翔, 速度跟随, 落地停止)
  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  windSet(vol: number): void {
    if (!this.ctx || !this.noiseBuf || !this.master) return;
    if (!this.windSrc) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 800;
      bp.Q.value = 0.5;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.master);
      src.start();
      this.windSrc = src;
      this.windGain = g;
    }
    (this.windGain as GainNode).gain.setTargetAtTime(vol * 0.3, this.ctx.currentTime, 0.1);
  }

  windStop(): void {
    if (this.windGain && this.ctx) {
      this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
    }
    const src = this.windSrc;
    this.windSrc = null;
    this.windGain = null;
    if (src) {
      window.setTimeout(() => {
        try {
          src.stop();
        } catch {
          /* 已停止 */
        }
      }, 450);
    }
  }

  // 运输机引擎低鸣(双锯齿微失谐 + 低通; 舱内阶段循环, 跳伞后淡出)
  private planeOsc: OscillatorNode[] | null = null;
  private planeGain: GainNode | null = null;
  planeDroneSet(vol: number): void {
    if (!this.ctx || !this.master) return;
    if (!this.planeOsc) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 150;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      lp.connect(g).connect(this.master);
      const o1 = this.ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 52;
      const o2 = this.ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = 52.8;
      o1.connect(lp);
      o2.connect(lp);
      o1.start();
      o2.start();
      this.planeOsc = [o1, o2];
      this.planeGain = g;
    }
    (this.planeGain as GainNode).gain.setTargetAtTime(vol * 0.16, this.ctx.currentTime, 0.15);
  }

  planeDroneStop(): void {
    if (this.planeGain && this.ctx) {
      this.planeGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    }
    const oscs = this.planeOsc;
    this.planeOsc = null;
    this.planeGain = null;
    if (oscs) {
      window.setTimeout(() => {
        for (const o of oscs) {
          try {
            o.stop();
          } catch {
            /* 已停止 */
          }
        }
      }, 600);
    }
  }
}
