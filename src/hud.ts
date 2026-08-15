// HUD: DOM 覆盖层管理(血量/护甲/弹药/背包/击杀/毒圈/信息流/准星/受击方向/提示)
import { fmtTime } from './utils';
import type { ArmorState, GameStats } from './types';
import { ARMORS, type ArmorKind } from './armor';
import type { HealId } from './heals';
import type { WeatherKind } from './environment';
import type { ScopeMode } from './gunplay';
import { SQUAD_ORDER_LABELS, type SquadOrderKind } from './squadcommands';
import type { PlayerFlowTone } from './playerflow';
import { MATCH_PLAYER_COUNT } from './matchbalance';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`缺少 DOM 元素 #${id}`);
  return e as T;
}

export type HitKind = 'hit' | 'head' | 'kill';
export type ToastTone = PlayerFlowTone;

export function matchCountLabels(playerCount = MATCH_PLAYER_COUNT): {
  alive: string;
  start: string;
  death: string;
  win: string;
} {
  return {
    alive: `剩余 ${playerCount}`,
    start: `${playerCount} 人孤岛大逃杀 · 单人对战 AI · 活到最后`,
    death: `#${playerCount} / ${playerCount}`,
    win: `#1 / ${playerCount}`,
  };
}

const TOAST_PRIORITY: Record<ToastTone, number> = {
  info: 0,
  success: 1,
  warning: 2,
  danger: 3,
};

export function toastShouldInterrupt(current: ToastTone, incoming: ToastTone): boolean {
  return TOAST_PRIORITY[incoming] >= TOAST_PRIORITY[current];
}

export function selectQueuedToast<T extends { tone: ToastTone }>(queued: T | null, incoming: T): T {
  return !queued || toastShouldInterrupt(queued.tone, incoming.tone) ? incoming : queued;
}

export function shouldShowSwimmingStatus(swimming: boolean, descentActive: boolean): boolean {
  return swimming && !descentActive;
}

export function compactHealCounts(bandage: number, medkit: number, drink: number): string {
  const parts: string[] = [];
  if (bandage > 0) parts.push(`绷带 ${bandage}`);
  if (medkit > 0) parts.push(`医疗 ${medkit}`);
  if (drink > 0) parts.push(`饮料 ${drink}`);
  return parts.join(' · ');
}

export function healthFeedback(hp: number): { opacity: number; critical: boolean } {
  const pct = Math.max(0, Math.min(100, hp));
  const danger = Math.max(0, Math.min(1, (55 - pct) / 55));
  return {
    opacity: danger * 0.72,
    critical: pct > 0 && pct <= 25,
  };
}

export interface BackpackData {
  slots: { key: string; label: string; name: string; mag: string }[];
  ammo: { name: string; count: number }[];
  throwables: { name: string; count: number }[];
  armor: { name: string; value: string }[];
  weight: { cur: number; cap: number };
  packName: string;
  heals: { id: HealId; name: string; count: number }[];
}

export interface SquadHudRow {
  name: string;
  hp: number;
  alive: boolean;
  isPlayer: boolean;
  knocked?: boolean;
}

export class Hud {
  private readonly events = new AbortController();
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
  private bombardmentStatus = el('bombardment-status');
  private environmentStatus = el('environment-status');
  private envIcon = el('env-icon');
  private envTime = el('env-time');
  private envLabel = el('env-label');
  private matchRule = el('match-rule');
  private soundToggle = el<HTMLButtonElement>('sound-toggle');
  private soundToggleIcon = el('sound-toggle-icon');
  private soundToggleLabel = el('sound-toggle-label');
  private locationStatus = el('location-status');
  private locationName = el('location-name');
  private locationTier = el('location-tier');
  private locationFeature = el('location-feature');
  private killfeed = el('killfeed');
  private crosshair = el('crosshair');
  private scopeMode: ScopeMode = 'none';
  private hitmarkerEl = el('hitmarker');
  private dmgArc = el('dmg-arc');
  private healthVignette = el('health-vignette');
  private blastFlash = el('blast-flash');
  private stunFlash = el('stun-flash');
  private toastEl = el('toast');
  private zoneTint = el('zone-tint');
  private hud = el('hud');
  private pickupPrompt = el('pickup-prompt');
  private squadPanel = el('squad-panel');
  private squadOrder = el('squad-order');
  private squadOrderTitle = el('squad-order-title');
  private squadOrderDetail = el('squad-order-detail');
  private altMeter = el('alt-meter');
  private vehiclePanel = el('vehicle-panel');
  private vehicleSpeed = el('vehicle-speed');
  private vehicleHpFill = el('vehicle-hp-fill');
  private healCast = el('heal-cast');
  private healLabel = el('heal-label');
  private healFill = el('heal-fill');
  private healCountsEl = el('heal-counts');
  private drinkBuff = el('drink-buff');
  private drinkBuffFill = el('drink-buff-fill');
  private swimTag = el('swim-tag');
  private knockBanner = el('knock-banner');
  private knockBleedFill = el('knock-bleed-fill');
  private knockSub = el('knock-sub');
  private backpack = el('backpack');
  private bpContent = el('bp-content');

  private screens = {
    start: el('screen-start'),
    death: el('screen-death'),
    win: el('screen-win'),
    pause: el('screen-pause'),
  };

  private toastTimer = 0;
  private toastTone: ToastTone = 'info';
  private queuedToast: { message: string; tone: ToastTone } | null = null;
  private hitTimer = 0;
  private shotPulseTimer = 0;
  private dmgTimer = 0;
  private blastTimer = 0;
  private stunTimer = 0;
  private healCountsKey = '';
  private environmentKey = '';
  private bombardmentKey = '';
  private locationKey = '';
  private hpKey = '';
  private swimmingKey: boolean | null = null;
  private weaponKey = '';
  private noAmmoKey: boolean | null = null;
  private countsKey = '';
  private zoneKey = '';
  private pickupKey: string | null | undefined;
  private interactionConfirmTimer = 0;
  private altitudeKey = '';
  private knockedKey: boolean | null = null;
  private knockBleedKey = '';
  private knockSubKey = '';
  private vehicleKey = '';
  private healCastKey = '';
  private drinkBuffKey = '';
  private crosshairKey = '';
  private zoneTintKey: boolean | null = null;
  private squadOrderKey = '';
  private locationTimer = 0;

  onStart: () => void = () => undefined;
  onRestart: () => void = () => undefined;
  onResume: () => void = () => undefined;
  onUseHeal: (id: HealId) => void = () => undefined;
  onCloseBackpack: () => void = () => undefined;
  onToggleSound: () => void = () => undefined;

  constructor() {
    const listenerOptions = { signal: this.events.signal };
    const countLabels = matchCountLabels();
    el('alive-count').textContent = countLabels.alive;
    el('start-match-summary').textContent = countLabels.start;
    el('death-placement').textContent = countLabels.death;
    el('win-placement').textContent = countLabels.win;
    el<HTMLButtonElement>('btn-start').addEventListener('click', () => this.onStart(), listenerOptions);
    el<HTMLButtonElement>('btn-again').addEventListener('click', () => this.onRestart(), listenerOptions);
    el<HTMLButtonElement>('btn-again-win').addEventListener('click', () => this.onRestart(), listenerOptions);
    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.onResume(), listenerOptions);
    this.soundToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onToggleSound();
    }, listenerOptions);
    this.backpack.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.id === 'bp-close') this.onCloseBackpack();
      else if (t.id.startsWith('bp-use-')) this.onUseHeal(t.id.slice(7) as HealId);
    }, listenerOptions);
  }

  dispose(): void {
    this.events.abort();
  }

  setSoundMuted(muted: boolean): void {
    this.soundToggle.dataset.muted = String(muted);
    this.soundToggle.setAttribute('aria-pressed', String(muted));
    this.soundToggleIcon.textContent = muted ? '🔇' : '🔊';
    this.soundToggleLabel.textContent = muted ? '静音' : '声音';
    this.soundToggle.title = muted ? '开启游戏声音 (M)' : '关闭游戏声音 (M)';
  }

  showScreen(name: 'start' | 'death' | 'win' | 'pause' | null): void {
    for (const key of Object.keys(this.screens) as (keyof Hud['screens'])[]) {
      this.screens[key].classList.toggle('hidden', key !== name);
    }
    this.hud.classList.toggle('hidden', name === 'start');
  }

  setDeath(stats: GameStats, detail: string): void {
    el('death-reason').textContent = detail;
    el('death-placement').textContent = `#${stats.placement} / ${MATCH_PLAYER_COUNT}`;
    el('death-kills').textContent = String(stats.kills);
    el('death-damage').textContent = String(Math.round(stats.damage));
    el('death-time').textContent = fmtTime(stats.timeSec);
  }

  setWin(stats: GameStats, detail: string): void {
    el('win-detail').textContent = detail;
    el('win-kills').textContent = String(stats.kills);
    el('win-damage').textContent = String(Math.round(stats.damage));
    el('win-time').textContent = fmtTime(stats.timeSec);
  }

  setHP(hp: number): void {
    const pct = Math.max(0, Math.min(100, hp));
    const visualPct = pct.toFixed(2);
    if (visualPct === this.hpKey) return;
    this.hpKey = visualPct;
    this.hpFill.style.width = `${visualPct}%`;
    this.hpText.textContent = String(Math.ceil(pct));
    const hue = (pct / 100) * 115; // 绿→红
    this.hpFill.style.backgroundColor = `hsl(${hue.toFixed(2)}, 75%, 45%)`;
    const health = healthFeedback(pct);
    this.healthVignette.style.setProperty('--health-danger', health.opacity.toFixed(3));
    this.healthVignette.classList.toggle('critical', health.critical);
  }

  // '游泳中'状态标
  setSwimming(on: boolean): void {
    if (on === this.swimmingKey) return;
    this.swimmingKey = on;
    this.swimTag.classList.toggle('show', on);
    this.swimTag.setAttribute('aria-hidden', on ? 'false' : 'true');
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
    const key = `${name}|${mag}|${reserve}|${mode}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;
    this.weaponName.textContent = name;
    this.ammoMag.textContent = mag;
    this.ammoReserve.textContent = reserve;
    this.fireMode.textContent = mode;
  }

  // 弹匣空且无备弹: 弹药计数标红
  setNoAmmo(on: boolean): void {
    if (on === this.noAmmoKey) return;
    this.noAmmoKey = on;
    this.ammoMag.classList.toggle('noammo', on);
    this.ammoReserve.classList.toggle('noammo', on);
  }

  setSlots(names: (string | null)[], active: number): void {
    for (let i = 0; i < this.slotEls.length; i++) {
      const e = this.slotEls[i] as HTMLElement;
      const label = names[i];
      const key = document.createElement('span');
      key.className = 'slot-key';
      key.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'slot-name';
      name.textContent = label ?? '空';
      e.replaceChildren(key, name);
      e.classList.toggle('active', i === active);
      e.classList.toggle('empty', label === null);
    }
  }

  setCounts(alive: number, kills: number): void {
    const key = `${alive}|${kills}`;
    if (key === this.countsKey) return;
    this.countsKey = key;
    this.aliveEl.textContent = `剩余 ${alive}`;
    this.killsEl.textContent = `击杀 ${kills}`;
  }

  setZoneStatus(text: string, urgent: boolean): void {
    const key = `${text}|${urgent ? 1 : 0}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    this.zoneStatus.textContent = text;
    this.zoneStatus.classList.toggle('urgent', urgent);
  }

  setBombardment(text: string | null, active: boolean): void {
    const key = `${text ?? ''}|${active ? 1 : 0}`;
    if (key === this.bombardmentKey) return;
    this.bombardmentKey = key;
    this.bombardmentStatus.textContent = text ?? '';
    this.bombardmentStatus.classList.toggle('show', text !== null);
    this.bombardmentStatus.classList.toggle('active', active);
  }

  setEnvironment(time: string, phase: string, label: string, weather: WeatherKind): void {
    const key = `${time}|${phase}|${label}|${weather}`;
    if (key === this.environmentKey) return;
    this.environmentKey = key;
    const icons: Record<WeatherKind, string> = {
      clear: '☀︎', cloudy: '☁︎', rain: '☂︎', snow: '❄', fog: '≡', storm: 'ϟ',
    };
    this.envIcon.textContent = icons[weather];
    this.envTime.textContent = time;
    this.envLabel.textContent = `${phase} · ${label}`;
    this.environmentStatus.dataset.weather = weather;
    this.environmentStatus.title = `${time} ${phase} · ${label}`;
  }

  setMatchRule(label: string, detail: string): void {
    this.matchRule.textContent = label;
    this.matchRule.title = detail;
    this.environmentStatus.dataset.rule = label;
  }

  setLocation(name: string, tier: 'low' | 'medium' | 'high', feature: string): void {
    const key = `${name}|${tier}|${feature}`;
    if (key === this.locationKey) return;
    this.locationKey = key;
    this.locationName.textContent = name;
    this.locationTier.textContent = tier === 'high' ? '高资源区' : tier === 'medium' ? '中资源区' : '低资源区';
    this.locationFeature.textContent = feature;
    this.locationStatus.dataset.tier = tier;
    this.locationStatus.title = `${this.locationTier.textContent} · ${feature}`;
    this.locationStatus.classList.add('show');
    this.locationTimer = 3.6;
  }

  setPickupPrompt(text: string | null, kind = 'default', detail = '', detailTone = 'neutral'): void {
    const key = text ? `${kind}|${text}|${detail}|${detailTone}` : null;
    if (key === this.pickupKey) return;
    this.pickupKey = key;
    if (text) {
      // 键位名渲染为 kbd 芯片
      const primary = text.replace(/ (F|Space) /g, ' <span class="kbd">$1</span> ');
      this.pickupPrompt.innerHTML = detail
        ? `<span class="prompt-primary">${primary}</span><span class="prompt-detail" data-tone="${detailTone}">${detail}</span>`
        : primary;
      this.pickupPrompt.dataset.kind = kind;
      this.pickupPrompt.classList.add('show');
    } else {
      this.pickupPrompt.classList.remove('show');
      delete this.pickupPrompt.dataset.kind;
    }
  }

  flashInteraction(kind: 'pickup' | 'interact' | 'vehicle' | 'blocked'): void {
    this.interactionConfirmTimer = 0.24;
    this.crosshair.dataset.confirm = kind;
    this.crosshair.classList.remove('interaction-confirm');
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add('interaction-confirm');
  }

  // 治疗绿闪(绷带/医疗包/饮料生效时)
  flashHeal(): void {
    const el = document.getElementById('heal-flash');
    if (!el) return;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  // 空降仪表(高度+垂直速度; alt<0 隐藏)
  setAltitude(alt: number, vy: number): void {
    if (alt < 0) {
      if (this.altitudeKey === 'hidden') return;
      this.altitudeKey = 'hidden';
      this.altMeter.classList.remove('show');
      return;
    }
    const text = `高度 ${Math.max(0, Math.round(alt))}m · 下降 ${Math.round(Math.abs(vy))} m/s`;
    if (text === this.altitudeKey) return;
    this.altitudeKey = text;
    this.altMeter.classList.add('show');
    this.altMeter.textContent = text;
  }

  // 小队面板(玩家高亮, 变化才写 DOM)
  private squadKey = '';
  setSquad(rows: readonly SquadHudRow[]): void {
    let key = '';
    for (const row of rows) key += `${Math.ceil(row.hp)}${row.alive ? 1 : 0}${row.knocked ? 1 : 0}|`;
    if (key === this.squadKey) return;
    this.squadKey = key;
    this.squadPanel.innerHTML = rows
      .map(
        (r) =>
          `<div class="sq-row${r.isPlayer ? ' me' : ''}${r.alive ? '' : ' dead'}${r.knocked ? ' knocked' : ''}">` +
          `<span class="sq-name">${r.name}</span>` +
          `<div class="sq-bar"><div class="sq-fill" style="width:${Math.max(0, Math.min(100, r.hp))}%"></div></div>` +
          `</div>`,
      )
      .join('');
  }

  setSquadOrder(kind: SquadOrderKind, targetName = '', sharedContactName = ''): void {
    const detail = sharedContactName && kind !== 'focus'
      ? `共享接敌: ${sharedContactName} · G 集火`
      : kind === 'follow' ? 'G/中键 标记 · H 警戒' : 'J 恢复跟随';
    const title = kind === 'focus' && targetName
      ? `${SQUAD_ORDER_LABELS[kind]}: ${targetName}`
      : SQUAD_ORDER_LABELS[kind];
    const key = `${kind}|${title}|${detail}`;
    if (key === this.squadOrderKey) return;
    this.squadOrderKey = key;
    this.squadOrder.dataset.kind = kind;
    this.squadOrderTitle.textContent = title;
    this.squadOrderDetail.textContent = detail;
    this.squadOrder.title = detail;
  }

  // 击倒横幅(玩家): 显隐 + 流血条 + 副标题
  setKnocked(on: boolean): void {
    if (on === this.knockedKey) return;
    this.knockedKey = on;
    this.knockBanner.classList.toggle('show', on);
  }

  setKnockBleed(frac: number): void {
    const key = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1);
    if (key === this.knockBleedKey) return;
    this.knockBleedKey = key;
    this.knockBleedFill.style.width = `${key}%`;
  }

  setKnockSub(text: string): void {
    if (text === this.knockSubKey) return;
    this.knockSubKey = text;
    this.knockSub.textContent = text;
  }

  // 载具仪表(速度 km/h + 车况条; kmh<0 隐藏)
  setVehicle(kmh: number, hpFrac: number): void {
    if (kmh < 0) {
      if (this.vehicleKey === 'hidden') return;
      this.vehicleKey = 'hidden';
      this.vehiclePanel.classList.remove('show');
      return;
    }
    const speed = Math.round(kmh);
    const hp = Math.round(Math.max(0, Math.min(1, hpFrac)) * 100);
    const key = `${speed}|${hp}`;
    if (key === this.vehicleKey) return;
    this.vehicleKey = key;
    this.vehiclePanel.classList.add('show');
    this.vehicleSpeed.textContent = `${speed} km/h`;
    this.vehicleHpFill.style.width = `${hp}%`;
  }

  // frac in [0,1] 显示持续交互进度, 其他值隐藏
  setHealCast(frac: number, label = '恢复中…'): void {
    if (frac >= 0 && frac <= 1) {
      const progress = (frac * 100).toFixed(0);
      const key = `${label}|${progress}`;
      if (key === this.healCastKey) return;
      this.healCastKey = key;
      this.healCast.classList.add('show');
      this.healLabel.textContent = label;
      this.healFill.style.width = `${progress}%`;
    } else {
      if (this.healCastKey === 'hidden') return;
      this.healCastKey = 'hidden';
      this.healCast.classList.remove('show');
    }
  }

  // 底栏恢复品计数(字符串化, 变化才写 DOM)
  setHeals(bandage: number, medkit: number, drink: number): void {
    const counts = compactHealCounts(bandage, medkit, drink);
    if (counts === this.healCountsKey) return;
    this.healCountsKey = counts;
    this.healCountsEl.textContent = counts;
    this.healCountsEl.classList.toggle('show', counts.length > 0);
  }

  // 饮料 buff 指示: frac∈[0,1] 显示剩余进度, 其他值隐藏
  setDrinkBuff(frac: number): void {
    if (frac >= 0 && frac <= 1.001) {
      const key = (Math.min(1, frac) * 100).toFixed(0);
      if (key === this.drinkBuffKey) return;
      this.drinkBuffKey = key;
      this.drinkBuff.classList.add('show');
      this.drinkBuffFill.style.width = `${key}%`;
    } else {
      if (this.drinkBuffKey === 'hidden') return;
      this.drinkBuffKey = 'hidden';
      this.drinkBuff.classList.remove('show');
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
    const healRows = data.heals
      .map(
        (h) =>
          `<div class="bp-row"><span class="bp-name">${h.name}</span><span class="bp-mag">× ${h.count}</span>` +
          `<button id="bp-use-${h.id}" class="bp-btn" ${h.count > 0 ? '' : 'disabled'}>使用</button></div>`,
      )
      .join('');
    const capPct = Math.min(100, (data.weight.cur / Math.max(1, data.weight.cap)) * 100);
    const capRow =
      `<div class="bp-row bp-cap"><span class="bp-name">负重 ${data.weight.cur}/${data.weight.cap}</span>` +
      `<div class="bp-cap-bar"><div class="bp-cap-fill${capPct >= 100 ? ' full' : ''}" style="width:${capPct.toFixed(0)}%"></div></div></div>`;
    this.bpContent.innerHTML =
      capRow +
      `<div class="bp-section">武器</div>${slotRows}` +
      `<div class="bp-section">护具</div>${armorRows}` +
      `<div class="bp-row"><span class="bp-name">背包</span><span class="bp-mag">${data.packName}</span></div>` +
      `<div class="bp-section">弹药</div>${ammoRows}` +
      `<div class="bp-section">投掷物</div>${throwRows}` +
      `<div class="bp-section">恢复品 (X 智能使用)</div>${healRows}`;
  }

  killFeed(html: string): void {
    const div = document.createElement('div');
    div.className = 'feed-entry';
    div.innerHTML = html;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 4) {
      this.killfeed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      div.classList.add('fade');
      window.setTimeout(() => div.remove(), 600);
    }, 4000);
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

  flashShot(power: number): void {
    this.crosshair.style.setProperty('--shot-power', Math.max(0.7, Math.min(1.4, power)).toFixed(2));
    this.crosshair.classList.remove('shot-pulse');
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add('shot-pulse');
    this.shotPulseTimer = 0.14;
  }

  // angle: 屏幕空间弧度(0=正前方, 顺时针对准伤害来源)
  damageFrom(angle: number): void {
    this.dmgArc.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    this.dmgArc.style.opacity = '1';
    this.dmgTimer = 0.7;
  }

  flashBlast(strength: number): void {
    this.blastFlash.style.setProperty('--blast-strength', Math.max(0, Math.min(1, strength)).toFixed(2));
    this.blastFlash.classList.remove('show');
    void this.blastFlash.offsetWidth;
    this.blastFlash.classList.add('show');
    this.blastTimer = 0.58;
  }

  flashStun(duration: number): void {
    const seconds = Math.max(0.18, Math.min(3.8, duration));
    this.stunFlash.style.setProperty('--stun-duration', `${seconds.toFixed(2)}s`);
    this.stunFlash.style.setProperty('--stun-strength', Math.min(1, 0.28 + seconds / 3.8).toFixed(2));
    this.stunFlash.classList.remove('show');
    void this.stunFlash.offsetWidth;
    this.stunFlash.classList.add('show');
    this.stunTimer = seconds;
  }

  private showToast(message: string, tone: ToastTone): void {
    this.toastEl.textContent = message;
    this.toastEl.dataset.tone = tone;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    this.toastTone = tone;
    this.toastTimer = 1.8;
  }

  toast(message: string, tone: ToastTone = 'info'): void {
    if (this.toastTimer > 0 && !toastShouldInterrupt(this.toastTone, tone)) {
      this.queuedToast = selectQueuedToast(this.queuedToast, { message, tone });
      return;
    }
    this.showToast(message, tone);
  }

  resetFeedback(): void {
    this.toastTimer = 0;
    this.queuedToast = null;
    this.toastTone = 'info';
    this.toastEl.classList.remove('show');
    delete this.toastEl.dataset.tone;
    this.interactionConfirmTimer = 0;
    this.shotPulseTimer = 0;
    this.crosshair.classList.remove('interaction-confirm');
    this.crosshair.classList.remove('shot-pulse');
    delete this.crosshair.dataset.confirm;
  }

  setCrosshair(spreadPx: number, visible: boolean): void {
    const gap = spreadPx.toFixed(1);
    const key = `${gap}|${visible ? 1 : 0}`;
    if (key === this.crosshairKey) return;
    this.crosshairKey = key;
    this.crosshair.style.setProperty('--gap', `${gap}px`);
    this.crosshair.classList.toggle('hidden', !visible);
  }

  // 按瞄具显示独立准镜, 模式变化时才更新 DOM。
  setScope(mode: ScopeMode): void {
    if (mode === this.scopeMode) return;
    this.scopeMode = mode;
    const scope = el('scope');
    scope.classList.toggle('hidden', mode === 'none');
    scope.dataset.mode = mode;
  }

  setZoneTint(on: boolean): void {
    if (on === this.zoneTintKey) return;
    this.zoneTintKey = on;
    this.zoneTint.classList.toggle('on', on);
  }

  update(dt: number): void {
    if (this.locationTimer > 0) {
      this.locationTimer -= dt;
      if (this.locationTimer <= 0) this.locationStatus.classList.remove('show');
    }
    if (this.shotPulseTimer > 0) {
      this.shotPulseTimer -= dt;
      if (this.shotPulseTimer <= 0) this.crosshair.classList.remove('shot-pulse');
    }
    if (this.interactionConfirmTimer > 0) {
      this.interactionConfirmTimer -= dt;
      if (this.interactionConfirmTimer <= 0) {
        this.crosshair.classList.remove('interaction-confirm');
        delete this.crosshair.dataset.confirm;
      }
    }
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarkerEl.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) {
        this.toastEl.classList.remove('show');
        if (this.queuedToast) {
          const queued = this.queuedToast;
          this.queuedToast = null;
          this.showToast(queued.message, queued.tone);
        }
      }
    }
    if (this.dmgTimer > 0) {
      this.dmgTimer -= dt;
      if (this.dmgTimer <= 0) this.dmgArc.style.opacity = '0';
    }
    if (this.blastTimer > 0) {
      this.blastTimer -= dt;
      if (this.blastTimer <= 0) this.blastFlash.classList.remove('show');
    }
    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      if (this.stunTimer <= 0) this.stunFlash.classList.remove('show');
    }
  }
}
