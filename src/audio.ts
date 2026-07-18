// WebAudio 全合成音效(无音频文件)
import type { WeaponId } from './types';
import { clamp } from './utils';

export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  // 必须在用户手势中调用
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  private out(pan: number): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    if (Math.abs(pan) < 0.01) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master);
    return p;
  }

  // 噪声爆发: 枪声主体
  private noiseBurst(vol: number, pan: number, freq: number, q: number, dur: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime;
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
    src.connect(bp).connect(g).connect(dst);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // 低频体音: 枪声"砰"感
  private thump(vol: number, pan: number, f0: number, f1: number, dur: number): void {
    if (!this.ctx) return;
    const dst = this.out(pan);
    if (!dst) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dst);
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
  shot(kind: WeaponId, dist: number, pan: number): void {
    if (!this.ctx) return;
    const att = clamp(1.35 / (1 + dist * 0.028), 0.015, 1);
    switch (kind) {
      case 'pistol':
        this.noiseBurst(0.5 * att, pan, 1100, 0.9, 0.11);
        this.thump(0.35 * att, pan, 240, 70, 0.09);
        break;
      case 'rifle':
        this.noiseBurst(0.6 * att, pan, 750, 0.7, 0.15);
        this.thump(0.45 * att, pan, 190, 55, 0.13);
        break;
      case 'smg':
        this.noiseBurst(0.42 * att, pan, 1400, 1.1, 0.08);
        this.thump(0.25 * att, pan, 260, 90, 0.06);
        break;
      case 'sniper':
        this.noiseBurst(0.85 * att, pan, 420, 0.5, 0.38);
        this.thump(0.6 * att, pan, 130, 38, 0.32);
        break;
    }
  }

  hit(head: boolean): void {
    this.noiseBurst(0.4, 0, head ? 2600 : 320, 1.2, 0.06);
    if (head) this.blip(1400, 900, 0.06, 0.18, 'square');
  }

  kill(): void {
    this.blip(660, 660, 0.07, 0.22, 'sine');
    window.setTimeout(() => this.blip(880, 880, 0.12, 0.22, 'sine'), 80);
  }

  pickup(): void {
    this.blip(520, 820, 0.08, 0.2, 'square');
  }

  reload(): void {
    this.blip(300, 180, 0.05, 0.15, 'square');
    window.setTimeout(() => this.blip(420, 300, 0.05, 0.15, 'square'), 160);
  }

  empty(): void {
    this.blip(900, 700, 0.04, 0.12, 'square');
  }

  zoneTick(): void {
    this.blip(440, 430, 0.07, 0.12, 'sine');
  }

  // 近战挥击(风声): 噪声经带通高频→低频快速下扫, 软起音 —— 与枪声的短促爆音区分
  melee(dist: number, pan: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const dst = this.out(pan);
    if (!dst) return;
    const att = clamp(1.2 / (1 + dist * 0.03), 0.02, 1);
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.15;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.34 * att, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    src.connect(bp).connect(g).connect(dst);
    src.start(t);
    src.stop(t + 0.24);
  }

  // 木质命中(门未被打破)
  woodHit(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.42 * att, pan, 320, 1.0, 0.08);
    this.thump(0.3 * att, pan, 150, 70, 0.07);
  }

  // 门板破碎
  woodBreak(dist: number, pan: number): void {
    const att = clamp(1.3 / (1 + dist * 0.028), 0.02, 1);
    this.noiseBurst(0.55 * att, pan, 520, 0.7, 0.22);
    this.thump(0.4 * att, pan, 170, 55, 0.18);
  }

  // 玻璃命中(未碎)
  glassHit(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.34 * att, pan, 3200, 2.0, 0.06);
  }

  // 玻璃破碎
  glassBreak(dist: number, pan: number): void {
    const att = clamp(1.3 / (1 + dist * 0.028), 0.02, 1);
    this.noiseBurst(0.5 * att, pan, 2600, 1.2, 0.24);
    this.noiseBurst(0.3 * att, pan, 4300, 2.5, 0.3);
  }

  // 护甲碎裂: 金属崩裂声
  armorBreak(dist: number, pan: number): void {
    const att = clamp(1.4 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.5 * att, pan, 2400, 1.4, 0.18);
    this.noiseBurst(0.3 * att, pan, 3600, 2.2, 0.22);
    this.thump(0.3 * att, pan, 200, 90, 0.12);
  }

  // 手雷爆炸: 低频轰 + 噪声
  explosion(dist: number, pan: number): void {
    const att = clamp(2.4 / (1 + dist * 0.018), 0.02, 1);
    this.noiseBurst(1.0 * att, pan, 160, 0.35, 0.55);
    this.thump(0.9 * att, pan, 85, 24, 0.5);
  }

  // 烟雾弹起烟嘶嘶声
  hiss(dist: number, pan: number): void {
    const att = clamp(1.2 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.3 * att, pan, 5200, 0.6, 1.4);
  }

  // 门轴吱呀: 开门升调, 关门降调; 锯齿波 + 11Hz 颤音模拟干涩门轴
  creak(dist: number, pan: number, open: boolean): void {
    if (!this.ctx) return;
    const dst = this.out(pan);
    if (!dst) return;
    const att = clamp(1.5 / (1 + dist * 0.035), 0.02, 1);
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

  warn(): void {
    this.blip(520, 520, 0.1, 0.16, 'sine');
    window.setTimeout(() => this.blip(520, 520, 0.1, 0.16, 'sine'), 160);
  }

  step(): void {
    this.noiseBurst(0.1, 0, 240, 0.8, 0.045);
  }

  jumpLand(): void {
    this.noiseBurst(0.16, 0, 180, 0.8, 0.07);
  }
}
