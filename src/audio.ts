// WebAudio 全合成音效(无音频文件)
import type { WeaponId } from './types';
import { clamp } from './utils';

export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private rainLevel = 0;
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
    if (this.rainLevel > 0.01) this.ensureRainLoop();
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
    if (this.rainLevel > 0.01) this.ensureRainLoop();
    if (this.ctx && this.rainGain) {
      this.rainGain.gain.setTargetAtTime(this.rainLevel * 0.085, this.ctx.currentTime, 0.35);
    }
  }

  thunder(): void {
    this.noiseBurst(0.72, 0, 115, 0.3, 0.85);
    this.thump(0.68, 0, 72, 24, 0.7);
    window.setTimeout(() => this.noiseBurst(0.28, 0, 180, 0.4, 0.65), 180);
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
      case 'shotgun':
        // 霰弹: 低沉轰响(比步枪更低频更厚)
        this.noiseBurst(0.75 * att, pan, 380, 0.6, 0.3);
        this.thump(0.6 * att, pan, 120, 30, 0.3);
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

  step(vol = 1): void {
    this.noiseBurst(0.1 * vol, 0, 240, 0.8, 0.045);
  }

  // 入水扑通(玩家)
  splashIn(): void {
    this.noiseBurst(0.5, 0, 520, 0.8, 0.28);
    this.thump(0.32, 0, 280, 60, 0.22);
  }

  // 出水涉水(玩家)
  splashOut(): void {
    this.noiseBurst(0.24, 0, 720, 0.9, 0.18);
  }

  // 他人入水(距离/方位衰减)
  splashAt(dist: number, pan: number): void {
    const att = clamp(1.25 / (1 + dist * 0.03), 0.02, 1);
    this.noiseBurst(0.42 * att, pan, 560, 0.8, 0.24);
    this.thump(0.26 * att, pan, 240, 70, 0.18);
  }

  // 划水(玩家, 每 ~1.7m 一次)
  swimStroke(): void {
    this.noiseBurst(0.13, 0, 480, 0.7, 0.15);
  }

  // 他人划水(距离/方位衰减)
  swimStrokeAt(dist: number, pan: number): void {
    const att = clamp(1.1 / (1 + dist * 0.035), 0.015, 1);
    this.noiseBurst(0.2 * att, pan, 480, 0.7, 0.17);
  }

  jumpLand(): void {
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
    this.thump(0.35, 0, 160, 70, 0.12);
  }

  // 载具撞击
  vehicleImpact(dist: number, pan: number): void {
    const att = clamp(1.6 / (1 + dist * 0.03), 0.02, 1);
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
