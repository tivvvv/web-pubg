// HUD: DOM 覆盖层管理(血量/护甲/弹药/背包/击杀/毒圈/信息流/准星/受击方向/提示)
import { fmtTime } from './utils';
import type { ArmorState, GameStats } from './types';
import { ARMORS, type ArmorKind } from './armor';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`缺少 DOM 元素 #${id}`);
  return e as T;
}

export type HitKind = 'hit' | 'head' | 'kill';

export interface BackpackData {
  slots: { key: string; label: string; name: string; mag: string }[];
  ammo: { name: string; count: number }[];
  throwables: { name: string; count: number }[];
  armor: { name: string; value: string }[];
  medkits: number;
}

export class Hud {
  private hpFill = el('hp-fill');
  private hpText = el('hp-text');
  private armorHelmet = el('armor-helmet');
  private armorHelmetFill = el('armor-helmet-fill');
  private armorVest = el('armor-vest');
  private armorVestFill = el('armor-vest-fill');
  private weaponName = el('weapon-name');
  private ammoMag = el('ammo-mag');
  private ammoReserve = el('ammo-reserve');
  private fireMode = el('fire-mode');
  private slotEls = [el('slot-0'), el('slot-1'), el('slot-2'), el('slot-3'), el('slot-4')];
  private aliveEl = el('alive-count');
  private killsEl = el('kill-count');
  private zoneStatus = el('zone-status');
  private killfeed = el('killfeed');
  private crosshair = el('crosshair');
  private hitmarkerEl = el('hitmarker');
  private dmgArc = el('dmg-arc');
  private toastEl = el('toast');
  private zoneTint = el('zone-tint');
  private hud = el('hud');
  private pickupPrompt = el('pickup-prompt');
  private healCast = el('heal-cast');
  private healFill = el('heal-fill');
  private backpack = el('backpack');
  private bpContent = el('bp-content');

  private screens = {
    start: el('screen-start'),
    death: el('screen-death'),
    win: el('screen-win'),
    pause: el('screen-pause'),
  };

  private toastTimer = 0;
  private hitTimer = 0;
  private dmgTimer = 0;

  onStart: () => void = () => undefined;
  onRestart: () => void = () => undefined;
  onResume: () => void = () => undefined;
  onUseMedkit: () => void = () => undefined;
  onCloseBackpack: () => void = () => undefined;

  constructor() {
    el<HTMLButtonElement>('btn-start').addEventListener('click', () => this.onStart());
    el<HTMLButtonElement>('btn-again').addEventListener('click', () => this.onRestart());
    el<HTMLButtonElement>('btn-again-win').addEventListener('click', () => this.onRestart());
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.onResume());
    this.backpack.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.id === 'bp-use-medkit') this.onUseMedkit();
      else if (t.id === 'bp-close') this.onCloseBackpack();
    });
  }

  showScreen(name: 'start' | 'death' | 'win' | 'pause' | null): void {
    for (const key of Object.keys(this.screens) as (keyof Hud['screens'])[]) {
      this.screens[key].classList.toggle('hidden', key !== name);
    }
    this.hud.classList.toggle('hidden', name === 'start');
  }

  setDeath(stats: GameStats): void {
    el('death-placement').textContent = `#${stats.placement} / 24`;
    el('death-kills').textContent = String(stats.kills);
    el('death-damage').textContent = String(Math.round(stats.damage));
    el('death-time').textContent = fmtTime(stats.timeSec);
  }

  setWin(stats: GameStats): void {
    el('win-kills').textContent = String(stats.kills);
    el('win-damage').textContent = String(Math.round(stats.damage));
    el('win-time').textContent = fmtTime(stats.timeSec);
  }

  setHP(hp: number): void {
    const pct = Math.max(0, Math.min(100, hp));
    this.hpFill.style.width = `${pct}%`;
    this.hpText.textContent = String(Math.ceil(pct));
    const hue = (pct / 100) * 115; // 绿→红
    this.hpFill.style.backgroundColor = `hsl(${hue}, 75%, 45%)`;
  }

  // 护具栏: 等级配色耐久条, 空槽置灰
  setArmor(helmet: ArmorState | null, vest: ArmorState | null): void {
    this.setArmorSlot(this.armorHelmet, this.armorHelmetFill, helmet, 'helmet');
    this.setArmorSlot(this.armorVest, this.armorVestFill, vest, 'vest');
  }

  private setArmorSlot(box: HTMLElement, fill: HTMLElement, a: ArmorState | null, kind: ArmorKind): void {
    if (!a) {
      box.classList.add('dim');
      fill.style.width = '0%';
      return;
    }
    box.classList.remove('dim');
    const def = ARMORS[kind][a.level];
    const pct = Math.max(0, Math.min(100, (a.durability / def.maxDurability) * 100));
    fill.style.width = `${pct}%`;
    fill.style.backgroundColor = `#${def.color.toString(16).padStart(6, '0')}`;
  }

  // 武器面板(字符串化, 枪械/近战通用)
  setWeapon(name: string, mag: string, reserve: string, mode: string): void {
    this.weaponName.textContent = name;
    this.ammoMag.textContent = mag;
    this.ammoReserve.textContent = reserve;
    this.fireMode.textContent = mode;
  }

  setSlots(names: (string | null)[], active: number): void {
    for (let i = 0; i < this.slotEls.length; i++) {
      const e = this.slotEls[i] as HTMLElement;
      const label = names[i];
      e.textContent = `${i + 1} ${label ?? '空'}`;
      e.classList.toggle('active', i === active);
      e.classList.toggle('empty', label === null);
    }
  }

  setCounts(alive: number, kills: number): void {
    this.aliveEl.textContent = `剩余 ${alive}`;
    this.killsEl.textContent = `击杀 ${kills}`;
  }

  setZoneStatus(text: string, urgent: boolean): void {
    this.zoneStatus.textContent = text;
    this.zoneStatus.classList.toggle('urgent', urgent);
  }

  setPickupPrompt(text: string | null): void {
    if (text) {
      this.pickupPrompt.textContent = text;
      this.pickupPrompt.classList.add('show');
    } else {
      this.pickupPrompt.classList.remove('show');
    }
  }

  // frac in [0,1] 显示包扎进度, 其他值隐藏
  setHealCast(frac: number): void {
    if (frac >= 0 && frac <= 1) {
      this.healCast.classList.add('show');
      this.healFill.style.width = `${(frac * 100).toFixed(0)}%`;
    } else {
      this.healCast.classList.remove('show');
    }
  }

  showBackpack(on: boolean): void {
    this.backpack.classList.toggle('hidden', !on);
  }

  backpackUpdate(data: BackpackData): void {
    const slotRows = data.slots
      .map(
        (s) => `<div class="bp-row"><span class="bp-key">${s.key}</span><span class="bp-slot-label">${s.label}</span><span class="bp-name">${s.name}</span><span class="bp-mag">${s.mag}</span></div>`,
      )
      .join('');
    const ammoRows = data.ammo
      .map((a) => `<div class="bp-row"><span class="bp-name">${a.name}</span><span class="bp-mag">× ${a.count}</span></div>`)
      .join('');
    const throwRows = data.throwables
      .map((t) => `<div class="bp-row"><span class="bp-name">${t.name}</span><span class="bp-mag">× ${t.count}</span></div>`)
      .join('');
    const armorRows = data.armor
      .map((a) => `<div class="bp-row"><span class="bp-name">${a.name}</span><span class="bp-mag">${a.value}</span></div>`)
      .join('');
    this.bpContent.innerHTML =
      `<div class="bp-section">武器</div>${slotRows}` +
      `<div class="bp-section">护具</div>${armorRows}` +
      `<div class="bp-section">弹药</div>${ammoRows}` +
      `<div class="bp-section">投掷物</div>${throwRows}` +
      `<div class="bp-section">物资</div>` +
      `<div class="bp-row"><span class="bp-name">医疗包</span><span class="bp-mag">× ${data.medkits}</span>` +
      `<button id="bp-use-medkit" class="bp-btn" ${data.medkits > 0 ? '' : 'disabled'}>使用 (X)</button></div>`;
  }

  killFeed(text: string): void {
    const div = document.createElement('div');
    div.className = 'feed-entry';
    div.textContent = text;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 6) {
      this.killfeed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      div.classList.add('fade');
      window.setTimeout(() => div.remove(), 600);
    }, 5000);
  }

  clearFeed(): void {
    this.killfeed.innerHTML = '';
  }

  hitmarker(kind: HitKind): void {
    this.hitmarkerEl.classList.remove('head', 'kill', 'show');
    void this.hitmarkerEl.offsetWidth; // 重启动画
    if (kind === 'head') this.hitmarkerEl.classList.add('head');
    if (kind === 'kill') this.hitmarkerEl.classList.add('kill');
    this.hitmarkerEl.classList.add('show');
    this.hitTimer = 0.25;
  }

  // angle: 屏幕空间弧度(0=正前方, 顺时针对准伤害来源)
  damageFrom(angle: number): void {
    this.dmgArc.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    this.dmgArc.style.opacity = '1';
    this.dmgTimer = 0.7;
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    this.toastTimer = 1.8;
  }

  setCrosshair(spreadPx: number, visible: boolean): void {
    this.crosshair.style.setProperty('--gap', `${spreadPx.toFixed(1)}px`);
    this.crosshair.classList.toggle('hidden', !visible);
  }

  // AWM ADS 全屏瞄准镜
  setScope(on: boolean): void {
    el('scope').classList.toggle('hidden', !on);
  }

  setZoneTint(on: boolean): void {
    this.zoneTint.classList.toggle('on', on);
  }

  update(dt: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarkerEl.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    if (this.dmgTimer > 0) {
      this.dmgTimer -= dt;
      if (this.dmgTimer <= 0) this.dmgArc.style.opacity = '0';
    }
  }
}
