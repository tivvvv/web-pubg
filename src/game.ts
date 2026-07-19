// 总控: 主循环/对局状态/伤害结算/近战/拾取/背包/缩圈伤害/胜负判定
import * as THREE from 'three';

const UP_Y = new THREE.Vector3(0, 1, 0);
const MATE_NAMES = ['阿伟', '老六', '小胖'];
const MATE_SHIRTS = [0x3cb36a, 0x3f8a4e, 0x66a05a];

// 队友头顶名牌(绿色小字, 远处隐藏)
function makeNameTag(name: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 32;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.font = 'bold 20px sans-serif';
  g.textAlign = 'center';
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.lineWidth = 3;
  g.strokeText(name, 64, 22);
  g.fillStyle = 'rgba(110,230,140,0.95)';
  g.fillText(name, 64, 22);
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(1.5, 0.38, 1);
  return spr;
}

// 径向渐变纹理(贴地阴影: 黑芯透明边)
function makeRadialTexture(alpha: number, softness: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, `rgba(0,0,0,${alpha + softness})`);
  grad.addColorStop(0.55, `rgba(0,0,0,${alpha})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// 菱形拾取标记
function makeMarkerTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = 'rgba(255,225,90,0.95)';
  g.beginPath();
  g.moveTo(32, 6);
  g.lineTo(54, 30);
  g.lineTo(32, 58);
  g.lineTo(10, 30);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(60,45,10,0.9)';
  g.fillRect(29, 20, 6, 16);
  g.fillRect(29, 40, 6, 6);
  return new THREE.CanvasTexture(c);
}
import { ARMORS, armorFromLoot, armorLootKind, isArmorKind, type ArmorKind, type ArmorLevel } from './armor';
import { AudioSys } from './audio';
import { HEAL_WEIGHT, PACKS, ROUND_WEIGHT, THROW_WEIGHT, carryCapacity, carryWeight, isPackKind, packLootKind, packLevelFromLoot } from './backpack';
import { BotController, BOT_NAMES } from './bot';
import type { Destructible } from './buildings';
import { Character, BOT_SHIRTS } from './character';
import { Effects } from './effects';
import { Hud, type BackpackData } from './hud';
import { DRINK_DURATION, DRINK_TOTAL, HEALS, HEAL_ORDER, type HealId } from './heals';
import { Input, type Action } from './input';
import { LootManager, isWeaponKind, type LootItem } from './loot';
import { Minimap } from './minimap';
import { PlayerController } from './player';
import { GrenadeManager } from './throwables';
import { TeammateController } from './teammate';
import { VEHICLE_SPEC, VehicleManager, type Vehicle } from './vehicles';
import type { AmmoType, DestructibleLike, GameStats, LootKind, ThrowableId } from './types';
import { clamp, dist2D, rand } from './utils';
import { AMMO_BOX, AMMO_LOOT_KIND, AMMO_NAME, MELEE, THROWABLES, WEAPONS, ammoTypeFromLoot, applySpread, hitscan, makeShotResult } from './weapons';
import { MUZZLE_SCALE } from './weaponmodels';
import { WATER_Y, World, type StaticHit } from './world';
import { Zone } from './zone';

const TOTAL = 24;
const BOT_VS_PLAYER_DMG = 0.7; // bot 对玩家伤害系数, 保证 1v1 可赢
const SLOT_LABELS = ['主武器1', '主武器2', '手枪', '近战'];

export class Game {
  readonly world: World;
  readonly effects: Effects;
  readonly zone: Zone;
  readonly loot: LootManager;
  readonly grenades: GrenadeManager;
  readonly vehicles: VehicleManager;
  readonly hud: Hud;
  readonly audio: AudioSys;
  readonly input: Input;
  readonly chars: Character[] = [];
  readonly tmpV2 = new THREE.Vector2();
  readonly staticHit: StaticHit = { t: 0, kind: 'terrain' };

  promptItem: LootItem | null = null;   // 当前可拾取武器提示
  promptDoor: Destructible | null = null; // 当前可开/关的门提示(优先于武器当看得更正)
  promptVehicle: Vehicle | null = null;   // 当前可驾驶载具提示
  backpackOpen = false;
  viewFpp = false;                     // 第一人称(V 切换, 会话内跨对局记忆)
  healT = -1;                            // >0 = 恢复品读条中(剩余秒)
  healKind: HealId | null = null;        // 读条中的恢复品种类
  drinkT = -1;                           // >0 = 饮料 buff 剩余秒(20s/40HP 预算)
  flightAngle = 0;                       // 航线角(每局随机)
  private planeMesh: THREE.Group | null = null; // 运输机模型(舱内阶段可见)
  private zoneArmed = false;             // 跳伞后才启动毒圈计时
  shakeAmp = 0;                          // 相机震动幅度(爆炸)

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private minimap: Minimap;
  private charsGroup = new THREE.Group();
  private player: PlayerController | null = null;
  private bots: BotController[] = [];
  private mates: TeammateController[] = [];
  private squadTags: THREE.Sprite[] = [];
  private state: 'menu' | 'playing' | 'paused' | 'over' = 'menu';
  private lastT = performance.now();
  private menuCam = new THREE.PerspectiveCamera(60, 1, 0.5, 1200);
  private menuAngle = 0;
  private now = 0;
  private damageDealt = 0;
  private deathT = -1;
  private playerPlacement = TOTAL;
  private zoneDmgT = 0;
  private zoneTickT = 0;
  private minimapT = 0;
  private bpT = 0;
  private hudSlotsKey = '';
  private hudArmorKey = '';
  private shotDots: { x: number; z: number }[] = [];
  private mapVehicles: { x: number; z: number; dead: boolean }[] = [];
  private mapSquad: { x: number; z: number }[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];

  private shotRes = makeShotResult();
  private tmpDir = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpMuzzle = new THREE.Vector3();
  private tmpEnd = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();
  private tmpRight = new THREE.Vector3();
  private blobs: THREE.InstancedMesh;
  private lootMarker: THREE.Sprite;
  private doorFrame: THREE.Group;
  private doorFrameEdgeMat: THREE.LineBasicMaterial;
  private doorFrameGlowMat: THREE.MeshBasicMaterial;
  private tmpM4 = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.world = new World(this.scene);
    this.scene.add(this.charsGroup);
    // 贴地阴影(单 InstancedMesh, 每帧跟随角色)
    const blobGeo = new THREE.CircleGeometry(1, 20);
    blobGeo.rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(
      blobGeo,
      new THREE.MeshBasicMaterial({ map: makeRadialTexture(0, 0.42), transparent: true, depthWrite: false }),
      24,
    );
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 2;
    this.scene.add(this.blobs);
    // 交互高亮: F 拾取菱形标记 + 门框描边
    this.lootMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeMarkerTexture(), color: 0xffe14d, transparent: true, depthWrite: false }),
    );
    this.lootMarker.scale.set(0.42, 0.42, 1);
    this.lootMarker.visible = false;
    this.scene.add(this.lootMarker);
    this.doorFrame = new THREE.Group();
    // 干净描边(无对角线): 12 条盒棱线 + 一层柔和附加底光, 都不是线框三角面
    const doorEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({
        color: 0x9fd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    const doorGlow = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x6fc7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    this.doorFrame.add(doorEdge, doorGlow);
    this.doorFrameEdgeMat = doorEdge.material;
    this.doorFrameGlowMat = doorGlow.material;
    this.doorFrame.visible = false;
    this.scene.add(this.doorFrame);
    this.effects = new Effects(this.scene);
    this.zone = new Zone(this.scene);
    this.loot = new LootManager(this.scene);
    this.grenades = new GrenadeManager(this.scene);
    this.vehicles = new VehicleManager(this.scene);
    this.audio = new AudioSys();
    this.hud = new Hud();
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, this.world);
    this.input = new Input(
      this.renderer.domElement,
      (a) => this.onAction(a),
      (locked) => this.onLockChange(locked),
    );

    this.hud.onStart = () => this.startMatch();
    this.hud.onRestart = () => this.startMatch();
    this.hud.onResume = () => this.input.requestLock();
    this.hud.onUseHeal = (id) => {
      if (this.player) {
        this.useHealItem(this.player.char, id);
        this.refreshBackpack();
      }
    };
    this.hud.onCloseBackpack = () => this.toggleBackpack(false);

    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    this.hud.showScreen('start');
    this.renderer.setAnimationLoop(() => this.frame());
    (window as unknown as { __game?: Game }).__game = this;
  }

  get nowSec(): number {
    return this.now;
  }

  get stateStr(): string {
    return this.state;
  }

  get aliveCount(): number {
    let n = 0;
    for (const c of this.chars) if (c.alive) n++;
    return n;
  }

  // 玩家控制器访问器(队友 AI 用)
  get playerCtl(): PlayerController | null {
    return this.player;
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.menuCam.aspect = w / h;
    this.menuCam.updateProjectionMatrix();
    if (this.player) {
      this.player.camera.aspect = w / h;
      this.player.camera.updateProjectionMatrix();
    }
  }

  private onAction(a: Action): void {
    if (a === 'mute') {
      const m = this.audio.toggleMute();
      this.hud.toast(m ? '已静音 (M)' : '声音开启');
      return;
    }
    if (a === 'backpack') {
      if (this.state === 'playing' && !this.player?.descent) this.toggleBackpack();
      return;
    }
    if (this.state !== 'playing' || !this.player?.alive || this.backpackOpen) return;
    // 空降阶段: 仅 V 视角与 F 跳伞可用
    const descent = this.player.descent;
    if (descent) {
      if (a === 'viewmode') {
        this.viewFpp = !this.viewFpp;
        this.hud.toast(this.viewFpp ? '第一人称' : '第三人称');
      } else if (a === 'pickup' && descent === 'plane') {
        this.player.startFreefall(this);
      }
      return;
    }
    switch (a) {
      case 'reload': this.player.startReload(this); break;
      case 'slot1': this.player.switchSlot(0, this); break;
      case 'slot2': this.player.switchSlot(1, this); break;
      case 'slot3': this.player.switchSlot(2, this); break;
      case 'slot4': this.player.switchSlot(3, this); break;
      case 'pickup': {
        if (this.player.driving) this.player.tryExitVehicle(this);
        else this.playerPick();
        break;
      }
      case 'slot5': this.selectThrowable(); break;
      case 'heal': this.quickHeal(this.player.char); break;
      case 'viewmode':
        this.viewFpp = !this.viewFpp;
        this.hud.toast(this.viewFpp ? '第一人称' : '第三人称');
        break;
      case 'crouch': {
        // C: 站⇄蹲; 趴→蹲
        const c = this.player.char;
        c.setStance(c.stance === 'crouch' ? 'stand' : 'crouch');
        break;
      }
      case 'prone': {
        // Z: 站/蹲→趴; 趴→蹲
        const c = this.player.char;
        c.setStance(c.stance === 'prone' ? 'crouch' : 'prone');
        break;
      }
      case 'wheelUp': this.cycleSlot(-1); break;
      case 'wheelDown': this.cycleSlot(1); break;
      default: break;
    }
  }

  private cycleSlot(dir: number): void {
    const player = this.player as PlayerController;
    const c = player.char;
    let i = c.curSlot;
    for (let k = 0; k < 4; k++) {
      i = (i + dir + 4) % 4;
      if (i === 3 || c.guns[i]) {
        player.switchSlot(i, this);
        return;
      }
    }
  }

  private onLockChange(locked: boolean): void {
    if (this.input.testMode) return;
    if (!locked && this.state === 'playing' && !this.backpackOpen) {
      this.state = 'paused';
      this.hud.showScreen('pause');
    } else if (locked && this.state === 'paused') {
      this.state = 'playing';
      this.hud.showScreen(null);
    }
  }

  // ---- 背包 ----

  toggleBackpack(force?: boolean): void {
    if (this.state !== 'playing') return;
    this.backpackOpen = force ?? !this.backpackOpen;
    this.hud.showBackpack(this.backpackOpen);
    if (this.backpackOpen) {
      this.refreshBackpack();
      this.input.exitLock();
    } else {
      this.input.requestLock();
    }
  }

  refreshBackpack(): void {
    const player = this.player;
    if (!player) return;
    const c = player.char;
    const data: BackpackData = {
      slots: [0, 1, 2, 3].map((i) => {
        if (i < 3) {
          const g = c.guns[i];
          return {
            key: String(i + 1),
            label: SLOT_LABELS[i] as string,
            name: g ? g.def.name : '空',
            mag: g ? `弹匣 ${g.mag}` : '',
          };
        }
        return {
          key: '4',
          label: SLOT_LABELS[3] as string,
          name: c.melee.def.name,
          mag: '',
        };
      }),
      ammo: (['rifle', 'smg', 'sniper', 'pistol'] as const).map((t) => ({
        name: AMMO_NAME[t],
        count: c.ammo[t],
      })),
      throwables: (['frag', 'smoke'] as const).map((t) => ({
        name: THROWABLES[t].name,
        count: c.throwables[t],
      })),
      armor: (['helmet', 'vest'] as const).map((k) => {
        const a = c[k];
        return {
          name: k === 'helmet' ? '头盔' : '防弹衣',
          value: a ? `${ARMORS[k][a.level].name} · 耐久 ${Math.ceil(a.durability)}/${ARMORS[k][a.level].maxDurability}` : '无',
        };
      }),
      weight: { cur: Math.round(carryWeight(c)), cap: carryCapacity(c.pack) },
      packName: c.pack ? `${PACKS[c.pack.level].name} · +${PACKS[c.pack.level].bonus} 负重` : '无',
      heals: HEAL_ORDER.map((id) => ({ id, name: HEALS[id].name, count: c.heals[id] })),
    };
    this.hud.backpackUpdate(data);
  }

  // ---- 恢复品 ----

  // X = 智能快速恢复: ≤50 优先医疗包; <75 用绷带; 否则补饮料
  quickHeal(c: Character): void {
    if (this.healT > 0) return;
    if (c.hp <= 50 && c.heals.medkit > 0) return this.startHeal(c, 'medkit');
    if (c.hp < 75 && c.heals.bandage > 0) return this.startHeal(c, 'bandage');
    if (c.hp < 99.5 && c.heals.drink > 0) return this.startHeal(c, 'drink');
    this.hud.toast('没有可用的恢复品');
  }

  // 背包单项使用(带条件提示)
  useHealItem(c: Character, id: HealId): void {
    if (this.healT > 0) return;
    const def = HEALS[id];
    if (c.heals[id] <= 0) {
      this.hud.toast(`没有${def.name}`);
      return;
    }
    if (c.hp >= def.cap - 0.5) {
      this.hud.toast(id === 'bandage' ? '绷带最多恢复到 75 点' : '生命值已满');
      return;
    }
    this.startHeal(c, id);
  }

  private startHeal(c: Character, id: HealId): void {
    if (!c.alive || this.healT > 0) return;
    if (c.isPlayer && this.player?.descent) return; // 跳伞中禁用恢复品
    const def = HEALS[id];
    if (c.heals[id] <= 0 || c.hp >= def.cap - 0.5) return;
    this.healT = def.cast;
    this.healKind = id;
  }

  cancelHeal(reason: string): void {
    if (this.healT <= 0) return;
    this.healT = -1;
    this.healKind = null;
    this.hud.setHealCast(-1);
    this.hud.toast(reason);
  }

  private updateHeal(dt: number): void {
    if (this.healT > 0) {
      const player = this.player as PlayerController;
      const id = this.healKind as HealId;
      const def = HEALS[id];
      if (!player.char.alive) {
        this.healT = -1;
        this.healKind = null;
        this.hud.setHealCast(-1);
      } else {
        this.healT -= dt;
        this.hud.setHealCast(1 - Math.max(0, this.healT) / def.cast);
        if (this.healT <= 0) {
          const c = player.char;
          if (c.heals[id] > 0 && c.hp < def.cap - 0.5) {
            c.heals[id]--;
            if (id === 'drink') {
              this.drinkT = DRINK_DURATION; // 刷新 20s/40HP 预算(不叠加)
              this.audio.drink();
              this.hud.flashHeal();
              this.hud.toast('饮料生效: 生命持续恢复中…');
            } else if (id === 'medkit') {
              c.hp = 100;
              this.audio.medkitDone();
              this.hud.flashHeal();
              this.hud.toast('生命已完全恢复');
            } else {
              c.hp = Math.min(75, c.hp + 15);
              this.audio.heal();
              this.hud.flashHeal();
              this.hud.toast('恢复 15 点生命');
            }
          }
          this.healT = -1;
          this.healKind = null;
          this.hud.setHealCast(-1);
        }
      }
    }
    this.updateDrink(dt);
  }

  // 饮料 buff: 2 HP/s 平滑恢复, 可到 100
  private updateDrink(dt: number): void {
    if (this.drinkT <= 0) return;
    const c = this.player?.char;
    if (!c || !c.alive) {
      this.drinkT = -1;
      this.hud.setDrinkBuff(-1);
      return;
    }
    this.drinkT -= dt;
    if (c.hp < 100) c.hp = Math.min(100, c.hp + (DRINK_TOTAL / DRINK_DURATION) * dt);
    this.hud.setDrinkBuff(Math.max(0, this.drinkT) / DRINK_DURATION);
    if (this.drinkT <= 0) this.hud.setDrinkBuff(-1);
  }

  // 航线点: s 为里程(0→1000 穿越岛心, 高 200m)
  flightPoint(out: THREE.Vector3, s: number): void {
    const d = s - 500;
    out.set(Math.cos(this.flightAngle) * d, 200, Math.sin(this.flightAngle) * d);
  }

  // 玩家跳伞(手动/自动): 启动毒圈计时
  onPlayerJump(): void {
    this.zoneArmed = true;
  }

  // ---- 对局管理 ----

  startMatch(): void {
    this.audio.unlock();
    this.audio.windStop(); // 上一局可能死在自由落体(风声未停)
    // 清理旧角色
    this.charsGroup.clear();
    this.chars.length = 0;
    this.bots = [];
    this.mates = [];
    for (const t of this.squadTags) this.scene.remove(t);
    this.squadTags = [];
    // 上一局可能死在舱内(旧运输机未清)
    if (this.planeMesh) {
      this.scene.remove(this.planeMesh);
      this.planeMesh = null;
    }
    this.player = new PlayerController(0x3a6ea5);

    // 出生点: 拒绝采样, 最小间距
    const pts: { x: number; z: number }[] = [];
    let guard = 0;
    while (pts.length < TOTAL && guard++ < 6000) {
      const x = rand(-300, 300);
      const z = rand(-300, 300);
      if (!this.world.pointFree(x, z, 0.5, WATER_Y + 0.7, 12)) continue;
      let ok = true;
      for (const p of pts) {
        if (dist2D(p.x, p.z, x, z) < 52) {
          ok = false;
          break;
        }
      }
      if (ok) pts.push({ x, z });
    }
    // 兜底: 放宽间距
    guard = 0;
    while (pts.length < TOTAL && guard++ < 6000) {
      const x = rand(-320, 320);
      const z = rand(-320, 320);
      if (this.world.pointFree(x, z, 0.5, WATER_Y + 0.4, 13)) pts.push({ x, z });
    }
    // 极端兜底(几乎不可能触发)
    while (pts.length < TOTAL) pts.push({ x: rand(-60, 60), z: rand(-60, 60) });

    // 玩家: 进入舱内航线阶段(随机航线角)
    this.player.char.team = 'squad';
    this.flightAngle = rand(0, Math.PI * 2);
    this.player.descent = 'plane';
    this.player.planeS = 0;
    this.player.vy = 0;
    this.flightPoint(this.player.char.pos, 0);
    this.player.yaw = this.flightAngle + Math.PI / 2;
    this.chars.push(this.player.char);
    this.charsGroup.add(this.player.char.group);
    // 运输机模型(舱内阶段跟随航线)
    const planeMat = new THREE.MeshLambertMaterial({ color: 0x7a8288 });
    const plane = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 9), planeMat);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.18, 2.4), planeMat);
    wing.position.set(0, 0.9, -0.4);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 1.8), planeMat);
    tail.position.set(0, 1.4, 4.2);
    plane.add(body, wing, tail);
    this.planeMesh = plane;
    this.scene.add(plane);

    for (let i = 1; i < TOTAL; i++) {
      const p = pts[i] as { x: number; z: number };
      if (i <= 3) {
        // 队友 ×3(跟随飞机, 玩家起跳后错峰跳伞)
        const mate = new TeammateController(
          (MATE_NAMES[i - 1] ?? `队友${i}`) as string,
          (MATE_SHIRTS[i - 1] ?? 0x3cb36a) as number,
        );
        mate.char.pos.copy(this.player.char.pos);
        mate.char.airPose = 'fall';
        mate.descent = 'freefall';
        mate.vy = -2;
        this.mates.push(mate);
        this.chars.push(mate.char);
        this.charsGroup.add(mate.char.group);
        // 头顶名牌
        const tag = makeNameTag(mate.char.name);
        this.squadTags.push(tag);
        this.scene.add(tag);
        continue;
      }
      // 敌方 bot ×20(高空投放)
      const bot = new BotController(BOT_NAMES[(i - 1) % BOT_NAMES.length] ?? `玩家${i}`, BOT_SHIRTS[(i - 1) % BOT_SHIRTS.length] ?? 0x888888);
      // bot: 投放点高空自由落体(高度错开, 落地时间自然分散)
      bot.char.pos.set(p.x + rand(-25, 25), 190 + Math.random() * 45, p.z + rand(-25, 25));
      bot.char.yaw = rand(0, Math.PI * 2);
      bot.char.airPose = 'fall';
      bot.descent = 'freefall';
      bot.vy = -2;
      bot.dropTarget.set(p.x, 0, p.z);
      if (Math.random() < 0.3) bot.char.throwables.frag = 1; // 30% bot 携带 1 颗手雷
      if (Math.random() < 0.5) bot.char.heals.bandage = 1 + Math.floor(Math.random() * 2); // 50% 带 1~2 绷带
      if (Math.random() < 0.35) bot.char.pack = { level: Math.random() < 0.7 ? 1 : 2 }; // 35% 带 L1~L2 背包
      // 40% bot 开局自带 L1~L2 头盔/防弹衣
      if (Math.random() < 0.4) {
        const lv: ArmorLevel = Math.random() < 0.65 ? 1 : 2;
        bot.char.helmet = { level: lv, durability: ARMORS.helmet[lv].maxDurability };
      }
      if (Math.random() < 0.4) {
        const lv: ArmorLevel = Math.random() < 0.65 ? 1 : 2;
        bot.char.vest = { level: lv, durability: ARMORS.vest[lv].maxDurability };
      }
      this.bots.push(bot);
      this.chars.push(bot.char);
      this.charsGroup.add(bot.char.group);
    }

    this.shotDots = this.bots.map(() => ({ x: 0, z: 0 }));
    this.world.buildings.reset(); // 门窗恢复: 窗全修好, 门 30% 预破坏
    this.grenades.reset();
    this.shakeAmp = 0;
    this.loot.populate(this.world);
    this.vehicles.populate(this.world);
    this.mapVehicles = this.vehicles.list.map(() => ({ x: 0, z: 0, dead: false }));
    this.zone.reset();
    this.effects.reset();
    this.promptVehicle = null;
    this.audio.engineStop();
    this.now = 0;
    this.damageDealt = 0;
    this.deathT = -1;
    this.playerPlacement = TOTAL;
    this.zoneDmgT = 0;
    this.minimapT = 0;
    this.healT = -1;
    this.healKind = null;
    this.drinkT = -1;
    this.zoneArmed = false; // 跳伞前毒圈不计时
    this.hud.setAltitude(-1, 0);
    this.promptItem = null;
    this.promptDoor = null;
    this.backpackOpen = false;
    this.hudSlotsKey = '';

    this.hud.clearFeed();
    this.hud.setHP(100);
    this.hud.setCounts(TOTAL, 0);
    this.hud.setZoneTint(false);
    this.hud.showBackpack(false);
    this.hud.setHealCast(-1);
    this.hud.setDrinkBuff(-1);
    this.hud.setPickupPrompt(null);
    this.hud.showScreen(null);
    this.hud.toast('航线已开启: 按 F 跳伞');
    this.state = 'playing';
    this.onResize();
    this.input.requestLock();
  }

  // ---- 主循环 ----

  private frame(): void {
    const t = performance.now();
    const dt = Math.min((t - this.lastT) / 1000, 0.05);
    this.lastT = t;
    if (this.state === 'playing') {
      this.now += dt;
      this.update(dt);
    } else if (this.state === 'menu') {
      this.menuAngle += dt * 0.045;
      this.menuCam.position.set(Math.cos(this.menuAngle) * 240, 100, Math.sin(this.menuAngle) * 240);
      this.menuCam.lookAt(0, 4, 0);
    } else if (this.state === 'paused') {
      this.input.consumeMouse();
      this.input.consumeFirePressed();
    } else if (this.state === 'over' && this.player) {
      this.player.update(dt, this.input, this); // 仅相机
      this.effects.update(dt);
      this.grenades.update(dt, this);
      this.world.buildings.update(dt); // 门扇动画收尾
      for (const c of this.chars) c.syncModel(dt, false);
    }
    this.hud.update(dt);
    const cam = this.state === 'menu' || !this.player ? this.menuCam : this.player.camera;
    this.world.updateVisuals(dt, cam.position); // 水波/植被摇摆/云漂移(全状态)
    this.renderer.render(this.scene, cam);
  }

  // 贴地阴影跟随(单个 InstancedMesh 每帧重排, 零分配)
  private updateBlobShadows(): void {
    let i = 0;
    for (const c of this.chars) {
      if (!c.alive) continue;
      const prone = c.stanceF > 1.2;
      this.tmpP.set(c.pos.x, c.groundH + 0.035, c.pos.z);
      this.tmpQ.setFromAxisAngle(UP_Y, c.yaw);
      this.tmpS.set(prone ? 1.35 : 0.62, 1, prone ? 0.8 : 0.62);
      this.tmpM4.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.blobs.setMatrixAt(i, this.tmpM4);
      i++;
    }
    this.blobs.count = i;
    this.blobs.instanceMatrix.needsUpdate = true;
  }

  // 交互高亮: F 拾取菱形浮动标记 / 目标门脉冲描边
  private updateMarkers(): void {
    if (this.promptItem) {
      const gp = this.promptItem.group.position;
      this.lootMarker.visible = true;
      this.lootMarker.position.set(gp.x, gp.y + 1.1 + Math.sin(this.now * 5) * 0.07, gp.z);
      this.lootMarker.material.opacity = 0.75 + Math.sin(this.now * 6) * 0.25;
    } else {
      this.lootMarker.visible = false;
    }
    const d = this.promptDoor;
    if (d && d.alive) {
      const col = d.collider;
      this.doorFrame.visible = true;
      this.doorFrame.position.set((col.minX + col.maxX) / 2, (col.minY + col.maxY) / 2, (col.minZ + col.maxZ) / 2);
      this.doorFrame.scale.set(col.maxX - col.minX + 0.14, col.maxY - col.minY + 0.14, col.maxZ - col.minZ + 0.14);
      const pulse = 0.5 + Math.sin(this.now * 6) * 0.25;
      this.doorFrameEdgeMat.opacity = pulse;
      this.doorFrameGlowMat.opacity = pulse * 0.3;
    } else {
      this.doorFrame.visible = false;
    }
  }

  private update(dt: number): void {
    const player = this.player as PlayerController;
    // 1 输入→玩家
    player.update(dt, this.input, this);
    // 2 bots + 队友
    for (const b of this.bots) b.update(dt, this);
    for (const m of this.mates) m.update(dt, this);
    // 队友名牌跟随(60m 外隐藏)
    for (let i = 0; i < this.mates.length; i++) {
      const m = this.mates[i] as TeammateController;
      const tag = this.squadTags[i];
      if (!tag) continue;
      const c = m.char;
      const dp = Math.hypot(c.pos.x - player.char.pos.x, c.pos.z - player.char.pos.z);
      tag.visible = c.alive && dp < 60;
      tag.position.set(c.pos.x, c.pos.y + 2.05, c.pos.z);
    }
    // 3 毒圈(跳伞后才计时) + 运输机模型跟随/离场
    if (this.zoneArmed) {
      this.zone.update(dt);
      const pc = this.player?.char;
      if (pc) this.zone.trackPlayer(pc.pos.x, pc.pos.z);
      if (this.planeMesh) {
        this.scene.remove(this.planeMesh);
        this.planeMesh = null;
      }
    }
    if (this.planeMesh && player.descent === 'plane') {
      this.flightPoint(this.tmpP, player.planeS);
      this.planeMesh.position.set(this.tmpP.x, this.tmpP.y - 1.1, this.tmpP.z);
      this.planeMesh.rotation.y = Math.atan2(Math.cos(this.flightAngle), Math.sin(this.flightAngle));
    }
    if (this.zone.justBeganShrink) {
      this.hud.toast('毒圈开始缩小！');
      this.audio.warn();
    }
    this.updateZoneDamage(dt);
    // 4 角色间软碰撞
    this.separateChars();
    // 5 模型/特效/拾取物/包扎
    for (const c of this.chars) c.syncModel(dt, c.speed2d > 0.3);
    this.updateBlobShadows();
    this.updateMarkers();
    this.loot.update(dt);
    this.effects.update(dt);
    this.grenades.update(dt, this);
    this.vehicles.update(dt, this);
    this.world.buildings.update(dt); // 门扇开关动画
    this.shakeAmp *= Math.exp(-6 * dt);
    this.updateHeal(dt);
    this.world.updateShadow(player.char.pos.x, player.char.pos.z);
    // 6 死亡结算计时
    if (this.deathT > 0) {
      this.deathT -= dt;
      if (this.deathT <= 0) this.finalizeDeath();
    }
    // 7 HUD
    this.refreshHud();
    this.minimapT -= dt;
    if (this.minimapT <= 0) {
      this.minimapT = 0.12;
      this.refreshMinimap();
    }
    if (this.backpackOpen) {
      this.bpT -= dt;
      if (this.bpT <= 0) {
        this.bpT = 0.25;
        this.refreshBackpack();
      }
    }
  }

  private separateChars(): void {
    const cs = this.chars;
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i] as Character;
      if (!a.alive) continue;
      for (let j = i + 1; j < cs.length; j++) {
        const b = cs[j] as Character;
        if (!b.alive) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) * 0.5 / d;
        a.pos.x -= dx * push;
        a.pos.z -= dz * push;
        b.pos.x += dx * push;
        b.pos.z += dz * push;
      }
    }
  }

  private updateZoneDamage(dt: number): void {
    this.zoneDmgT += dt;
    if (this.zoneDmgT >= 0.5) {
      this.zoneDmgT -= 0.5;
      const dmg = this.zone.dps * 0.5;
      for (const c of this.chars) {
        if (c.alive && this.zone.isOutside(c.pos.x, c.pos.z)) {
          this.damageChar(c, dmg, false, null, undefined, true); // 毒圈无视护甲
        }
      }
    }
    const player = this.player;
    if (player && player.alive && this.zone.isOutside(player.char.pos.x, player.char.pos.z)) {
      this.zoneTickT -= dt;
      if (this.zoneTickT <= 0) {
        this.zoneTickT = 1;
        this.audio.zoneTick();
      }
    }
  }

  // ---- 载具座位(队友乘客) ----

  // 第一个空乘客位(返回索引, 无座返回 -1)
  freeSeat(v: Vehicle): number {
    return v.passengers.findIndex((p) => p === null);
  }

  boardSeat(v: Vehicle, idx: number, c: Character): void {
    v.passengers[idx] = c;
  }

  leaveSeat(v: Vehicle, idx: number): void {
    if (idx >= 0 && idx < v.passengers.length) v.passengers[idx] = null;
  }

  // 载具爆炸/熄火时强制司机下车(可带伤害; 目前仅玩家驾驶)
  forceExitVehicle(driver: Character, dmg: number): void {
    if (driver.isPlayer && this.player) {
      this.player.exitVehicle(this, true);
    }
    if (dmg > 0 && driver.alive) this.damageChar(driver, dmg, false, null, '载具爆炸', true);
  }

  // 碾压判定: 车速 >6m/s 撞人(重伤害+推开+减速)
  runOverCheck(v: Vehicle, driver: Character): void {
    const spec = VEHICLE_SPEC[v.kind];
    const sp = Math.abs(v.speed);
    for (const c of this.chars) {
      if (!c.alive || c === driver) continue;
      const dx = c.pos.x - v.pos.x;
      const dz = c.pos.z - v.pos.z;
      const rr = spec.radius + c.radius * 0.8;
      if (dx * dx + dz * dz > rr * rr) continue;
      if (Math.abs(c.pos.y - v.pos.y) > 2.2) continue;
      const dmg = Math.min(130, sp * 5);
      this.damageChar(c, dmg, false, driver, '载具撞击', true);
      const dl = Math.hypot(dx, dz) || 1;
      c.pos.x += (dx / dl) * 1.4;
      c.pos.z += (dz / dl) * 1.4;
      v.speed *= 0.8;
      this.effects.impactBlood(c.chestPos(this.tmpA));
    }
  }

  // ---- 射击结算 ----

  playerShot(): boolean {
    const player = this.player as PlayerController;
    this.tmpOrigin.copy(player.camera.position);
    player.camera.getWorldDirection(this.tmpDir); // 屏幕正中心, 含肩部视差修正
    return this.fireWeapon(player.char, this.tmpOrigin, this.tmpDir, player.spreadRad);
  }

  fireWeapon(shooter: Character, origin: THREE.Vector3, dir: THREE.Vector3, spread: number): boolean {
    const gun = shooter.heldGun();
    if (!gun || gun.mag <= 0) return false;
    gun.mag--;
    shooter.lastShotT = this.now;
    this.tmpA.copy(dir);
    applySpread(this.tmpA, spread, this.tmpEnd);
    hitscan(this.world, this.chars, shooter, origin, this.tmpA, 260, this.staticHit, this.shotRes);
    shooter.muzzleWorld(this.tmpMuzzle);
    this.effects.muzzleFlash(this.tmpMuzzle, MUZZLE_SCALE[gun.def.id]);
    const res = this.shotRes;
    // 载具命中判定: 命中比当前更近且非"打中该车司机"时, 视为车身中弹
    const vHit = this.vehicles.raycast(origin, this.tmpA, res.hit ? res.t : 260);
    if (vHit && (!res.hit || vHit.t < res.t) && !(res.char && res.char === vHit.v.driver && res.t < vHit.t + 0.6)) {
      this.tmpEnd.copy(origin).addScaledVector(this.tmpA, vHit.t);
      this.effects.tracer(this.tmpMuzzle, this.tmpEnd, 0xffd27a);
      this.effects.impactSpark(this.tmpEnd);
      this.vehicles.damage(vHit.v, gun.def.damage);
    } else if (res.hit) {
      this.effects.tracer(this.tmpMuzzle, res.point, 0xffd27a);
      if (res.char) {
        const victim = res.char;
        let dmg = gun.def.damage * (res.head ? gun.def.headMult : 1);
        if (!shooter.isPlayer && victim.isPlayer) dmg *= BOT_VS_PLAYER_DMG;
        this.effects.impactBlood(res.point);
        if (shooter.isPlayer) {
          this.damageDealt += dmg;
          this.audio.hit(res.head);
          this.hud.hitmarker(res.head ? 'head' : 'hit');
        }
        this.damageChar(victim, dmg, res.head, shooter);
        if (!victim.alive && shooter.isPlayer) this.hud.hitmarker('kill');
      } else if (res.surface === 'door' || res.surface === 'window') {
        // 可破坏物: 扣血 + 木屑/玻璃粒子音效
        const d = this.staticHit.destruct;
        if (d && d.alive) {
          this.hitDestructible(d, gun.def.damage, res.point);
        } else {
          this.effects.impactDust(res.point);
        }
      } else if (res.surface === 'terrain' || res.surface === 'floor') {
        this.effects.impactDust(res.point);
      } else if (res.surface === 'rock') {
        this.effects.impactRock(res.point);
      } else {
        this.effects.impactSpark(res.point);
      }
      // 弹着点入水: 白色溅沫
      if (res.point.y < WATER_Y) this.effects.splash(res.point);
    } else {
      this.tmpEnd.copy(origin).addScaledVector(this.tmpA, 260);
      this.effects.tracer(this.tmpMuzzle, this.tmpEnd, 0xffd27a);
    }
    // 音效: 他人枪声按距离/方位衰减
    if (shooter.isPlayer) {
      this.audio.shot(gun.def.id, 0, 0);
    } else if (this.player) {
      const cam = this.player.camera;
      this.tmpEnd.subVectors(shooter.pos, cam.position);
      const dist = this.tmpEnd.length();
      if (dist < 220) {
        this.tmpEnd.divideScalar(dist || 1);
        const e = cam.matrixWorld.elements;
        this.tmpRight.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0);
        const pan = this.tmpRight.dot(this.tmpEnd);
        this.audio.shot(gun.def.id, dist, pan);
      }
    }
    return true;
  }

  // ---- 可破坏物(门/窗) ----

  // 对可破坏物造成伤害: 木/玻璃粒子 + 方位音效, 破碎后洞口可通行可射击
  hitDestructible(d: DestructibleLike, dmg: number, point: THREE.Vector3): void {
    if (!d.alive) return;
    d.hp -= dmg;
    if (d.hp <= 0) {
      d.alive = false;
      d.mesh.visible = false;
      d.collider.off = true;
      this.tmpEnd.set(d.cx, d.cy, d.cz);
      if (d.kind === 'door') {
        this.effects.debrisWood(this.tmpEnd);
        this.soundAt(this.tmpEnd, (dist, pan) => this.audio.woodBreak(dist, pan));
      } else {
        this.effects.debrisGlass(this.tmpEnd);
        this.soundAt(this.tmpEnd, (dist, pan) => this.audio.glassBreak(dist, pan));
      }
    } else if (d.kind === 'door') {
      this.effects.impactWood(point);
      this.soundAt(point, (dist, pan) => this.audio.woodHit(dist, pan));
    } else {
      this.effects.impactGlass(point);
      this.soundAt(point, (dist, pan) => this.audio.glassHit(dist, pan));
    }
  }

  // 以玩家相机为听者的方位音效(复用枪声的 dist/pan 算法)
  soundAt(pos: THREE.Vector3, fn: (dist: number, pan: number) => void): void {
    if (!this.player) return;
    const cam = this.player.camera;
    this.tmpEnd.subVectors(pos, cam.position);
    const dist = this.tmpEnd.length();
    if (dist > 120) return;
    this.tmpEnd.divideScalar(dist || 1);
    const e = cam.matrixWorld.elements;
    this.tmpRight.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0);
    fn(dist, this.tmpRight.dot(this.tmpEnd));
  }

  // 找挡在角色行进方向上的活门/窗(2.2m 内, 朝向 dot>0.5), bot 破门用
  findBlockingDoor(c: Character, fx: number, fz: number): DestructibleLike | null {
    let best: DestructibleLike | null = null;
    let bestD = 2.2;
    for (const d of this.world.buildings.destructibles) {
      if (!d.alive || d.collider.off) continue; // 开着的门不再挡路
      const dx = d.cx - c.pos.x;
      const dz = d.cz - c.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bestD || dist < 0.01) continue;
      if ((dx * fx + dz * fz) / dist < 0.5) continue;
      if (Math.abs(d.cy - (c.pos.y + 1.2)) > 2.2) continue;
      best = d;
      bestD = dist;
    }
    return best;
  }

  // 玩家门交互候选: 2.2m 内看得最正的活门(返回门与朝向点积)
  findDoorInteraction(x: number, y: number, z: number, fx: number, fz: number): { d: Destructible; dot: number } | null {
    let best: Destructible | null = null;
    let bestDot = 0.35;
    for (const d of this.world.buildings.destructibles) {
      if (d.kind !== 'door' || !d.alive) continue;
      const dx = d.cx - x;
      const dz = d.cz - z;
      const dist = Math.hypot(dx, dz);
      if (dist > 2.2) continue;
      if (Math.abs(d.cy - (y + 1.2)) > 2.2) continue;
      const dot = dist > 0.01 ? (dx * fx + dz * fz) / dist : 1;
      if (dot < bestDot) continue;
      best = d;
      bestDot = dot;
    }
    return best ? { d: best, dot: bestDot } : null;
  }

  // 开/关门切换(玩家按 F); 带方位吱呀声
  toggleDoor(d: DestructibleLike): void {
    this.setDoor(d, !this.asDoor(d)?.open);
  }

  // bot 开门(幂等, 只开不关)
  openDoor(d: DestructibleLike): void {
    this.setDoor(d, true);
  }

  private asDoor(d: DestructibleLike): Destructible | null {
    const dd = d as Destructible;
    return dd.kind === 'door' && dd.alive ? dd : null;
  }

  private setDoor(d: DestructibleLike, open: boolean): void {
    const dd = this.asDoor(d);
    if (!dd) return;
    if (!this.world.buildings.setDoorOpen(dd, open)) return;
    this.tmpEnd.set(dd.cx, dd.cy, dd.cz);
    this.soundAt(this.tmpEnd, (dist, pan) => this.audio.creak(dist, pan, open));
  }

  // ---- 投掷物 ----

  // 按 5: 未选中则切到投掷栏; 已选中则在手雷/烟雾弹间循环
  private selectThrowable(): void {
    const player = this.player;
    if (!player) return;
    const c = player.char;
    if (c.curSlot === 4) {
      const other: ThrowableId = c.throwKind === 'frag' ? 'smoke' : 'frag';
      if (c.throwables[other] > 0) c.throwKind = other;
      return;
    }
    if (c.throwables.frag + c.throwables.smoke === 0) {
      this.hud.toast('没有投掷物');
      return;
    }
    if (c.throwables[c.throwKind] === 0) {
      c.throwKind = c.throwKind === 'frag' ? 'smoke' : 'frag';
    }
    player.switchSlot(4, this);
  }

  // 投出一颗投掷物(玩家与 bot 共用)
  throwGrenade(thrower: Character, kind: ThrowableId, origin: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    this.grenades.spawn(thrower, kind, origin, dir, speed);
    if (thrower.isPlayer) {
      this.audio.melee(0, 0);
    } else {
      this.soundAt(thrower.pos, (d, p) => this.audio.melee(d, p));
    }
  }

  // 爆炸引起的相机震动(按玩家距离衰减)
  addShakeFrom(pos: THREE.Vector3): void {
    if (!this.player) return;
    const d = Math.hypot(pos.x - this.player.char.pos.x, pos.y - this.player.char.pos.y, pos.z - this.player.char.pos.z);
    const amp = clamp(3.5 / (1 + d * 0.09), 0, 1.5);
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  }

  // 视线遮挡: 地形/建筑 + 烟幕球(bot 索敌共用)
  isLOSBlocked(a: THREE.Vector3, b: THREE.Vector3, tmpDir: THREE.Vector3): boolean {
    if (this.grenades.blocksLOS(a, b)) return true;
    return this.world.isLOSBlocked(a, b, tmpDir);
  }

  // ---- 近战结算 ----

  meleeAttack(attacker: Character): boolean {
    const m = attacker.melee.def;
    if (this.now - attacker.lastMeleeT < m.cooldown) return false;
    attacker.lastMeleeT = this.now;
    attacker.swingT = 1;
    attacker.swingSide *= -1; // 交替出拳
    // 砍刀: 白色斩击弧(纯表现, 对象池)
    if (m.id === 'knife') {
      this.tmpEnd.set(
        attacker.pos.x + Math.sin(attacker.yaw) * 0.7,
        attacker.pos.y + 1.25,
        attacker.pos.z + Math.cos(attacker.yaw) * 0.7,
      );
      this.effects.slashArc(this.tmpEnd, attacker.yaw, attacker.swingSide);
    }
    // 挥击音效(玩家原声, 他人按距离/方位)
    if (attacker.isPlayer) {
      this.audio.melee(0, 0);
    } else if (this.player) {
      const cam = this.player.camera;
      this.tmpEnd.subVectors(attacker.pos, cam.position);
      const dist = this.tmpEnd.length();
      if (dist < 60) {
        this.tmpEnd.divideScalar(dist || 1);
        const e = cam.matrixWorld.elements;
        this.tmpRight.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0);
        this.audio.melee(dist, this.tmpRight.dot(this.tmpEnd));
      }
    }
    // 锥形近战判定
    const fx = Math.sin(attacker.yaw);
    const fz = Math.cos(attacker.yaw);
    let best: Character | null = null;
    let bestD = m.range + 0.45;
    for (const c of this.chars) {
      if (!c.alive || c === attacker) continue;
      if (attacker.team === 'squad' && c.team === 'squad') continue; // 小队近战免伤
      const dx = c.pos.x - attacker.pos.x;
      const dz = c.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || Math.abs(c.pos.y - attacker.pos.y) > 2.2) continue;
      if (d > 0.01 && (dx * fx + dz * fz) / d < 0.8) continue; // ~±37°
      best = c;
      bestD = d;
    }
    if (best) {
      best.chestPos(this.tmpEnd);
      this.effects.impactBlood(this.tmpEnd);
      let dmg = m.damage;
      if (!attacker.isPlayer && best.isPlayer) dmg *= BOT_VS_PLAYER_DMG;
      if (attacker.isPlayer) {
        this.damageDealt += dmg;
        this.audio.hit(false);
        this.hud.hitmarker('hit');
      }
      this.damageChar(best, dmg, false, attacker);
      if (!best.alive && attacker.isPlayer) this.hud.hitmarker('kill');
    } else {
      // 无角色命中: 尝试打破面前的门/窗
      const range = m.range + 0.7;
      let bd: DestructibleLike | null = null;
      let bdDist = range;
      for (const d of this.world.buildings.destructibles) {
        if (!d.alive) continue;
        const col = d.collider;
        const nx = clamp(attacker.pos.x, col.minX, col.maxX);
        const nz = clamp(attacker.pos.z, col.minZ, col.maxZ);
        const dist = Math.hypot(nx - attacker.pos.x, nz - attacker.pos.z);
        if (dist > bdDist) continue;
        if (Math.abs(d.cy - (attacker.pos.y + 1.2)) > 2.0) continue;
        const ddx = d.cx - attacker.pos.x;
        const ddz = d.cz - attacker.pos.z;
        const dl = Math.hypot(ddx, ddz) || 1;
        if ((ddx * fx + ddz * fz) / dl < 0.6) continue;
        bd = d;
        bdDist = dist;
      }
      if (bd) {
        this.tmpEnd.set(bd.cx, bd.cy, bd.cz);
        this.hitDestructible(bd, m.damage, this.tmpEnd);
      }
    }
    return true;
  }

  // ---- 伤害/击杀 ----

  damageChar(victim: Character, dmg: number, head: boolean, attacker: Character | null, via?: string, ignoreArmor = false): void {
    if (!victim.alive) return;
    // 护具减伤: 子弹/近战有效; 爆炸与毒圈无视护甲
    if (!ignoreArmor) {
      const armor = head ? victim.helmet : victim.vest;
      if (armor) {
        const def = ARMORS[head ? 'helmet' : 'vest'][armor.level];
        dmg *= 1 - def.reduce;            // 减免后的实际伤害
        armor.durability -= dmg;          // 耐久吸收实际造成的伤害
        if (armor.durability <= 0) this.breakArmor(victim, head ? 'helmet' : 'vest');
      }
    }
    victim.hp -= dmg;
    victim.lastAttackerId = attacker?.id ?? 0;
    if (victim.isPlayer && dmg > 0) this.cancelHeal('受伤打断恢复'); // 新增: 受伤取消读条
    if (victim.isPlayer && attacker) {
      const ang = Math.atan2(attacker.pos.x - victim.pos.x, attacker.pos.z - victim.pos.z);
      const rel = ang - (this.player?.yaw ?? 0);
      this.hud.damageFrom(-rel);
      this.audio.hit(false);
    }
    if (victim.hp <= 0) this.kill(victim, attacker, head, via);
  }

  // 护甲耐久归零: 碎裂音效(附近可闻) + 玩家提示, 槽位清空
  private breakArmor(victim: Character, kind: ArmorKind): void {
    if (kind === 'helmet') victim.helmet = null;
    else victim.vest = null;
    this.tmpEnd.set(victim.pos.x, victim.pos.y + 1.2, victim.pos.z);
    this.soundAt(this.tmpEnd, (d, p) => this.audio.armorBreak(d, p));
    if (victim.isPlayer) this.hud.toast(kind === 'helmet' ? '头盔已损坏' : '防弹衣已损坏');
  }

  private kill(victim: Character, attacker: Character | null, head: boolean, via?: string): void {
    victim.hp = 0;
    victim.alive = false;
    victim.dieT = 0;
    victim.stance = 'stand'; // 死亡复位姿态
    victim.stanceF = 0;
    const placement = this.aliveCount + 1;

    // 掉落: 当前手持武器(保留弹匣), 否则随机物资
    const gx = victim.pos.x;
    const gz = victim.pos.z;
    const gy = this.world.getHeight(gx, gz);
    const held = victim.heldGun();
    if (held) {
      this.loot.spawn(held.def.id, gx + rand(-0.5, 0.5), gy, gz + rand(-0.5, 0.5), held.mag, 0);
    } else if (victim.melee.def.id === 'knife') {
      this.loot.spawn('knife', gx + rand(-0.5, 0.5), gy, gz + rand(-0.5, 0.5));
    } else {
      const kinds: LootKind[] = ['ammoRifle', 'ammoSmg', 'ammoPistol', 'ammoSniper'];
      const kind: LootKind = Math.random() < 0.4 ? 'bandage' : (kinds[Math.floor(Math.random() * kinds.length)] as LootKind);
      this.loot.spawn(kind, gx + rand(-0.5, 0.5), gy, gz + rand(-0.5, 0.5));
    }
    // 弹药储备按类型成包掉落
    for (const t of ['pistol', 'rifle', 'smg', 'sniper'] as const) {
      const n = victim.ammo[t];
      if (n > 0) this.loot.spawn(AMMO_LOOT_KIND[t], gx + rand(-0.7, 0.7), gy, gz + rand(-0.7, 0.7), -1, n);
    }
    // 恢复品掉落(成叠, ammo 字段携带数量)
    for (const id of HEAL_ORDER) {
      const n = victim.heals[id];
      if (n > 0) this.loot.spawn(id, gx + rand(-0.7, 0.7), gy, gz + rand(-0.7, 0.7), -1, n);
    }
    // 投掷物掉落(成小叠)
    for (const t of ['frag', 'smoke'] as const) {
      const n = victim.throwables[t];
      if (n > 0) {
        this.loot.spawn(t, gx + rand(-0.7, 0.7), gy, gz + rand(-0.7, 0.7), -1, n);
      }
    }
    // 护具掉落(保留剩余耐久)
    for (const kind of ['helmet', 'vest'] as const) {
      const a = victim[kind];
      if (a) {
        this.loot.spawn(
          armorLootKind(kind, a.level),
          gx + rand(-0.7, 0.7), gy, gz + rand(-0.7, 0.7),
          -1, Math.max(1, Math.round(a.durability)),
        );
      }
    }
    // 背包掉落
    if (victim.pack) {
      this.loot.spawn(packLootKind(victim.pack.level), gx + rand(-0.7, 0.7), gy, gz + rand(-0.7, 0.7));
    }

    // 击杀信息(玩家金 / 队友绿 / 敌人白)
    const ns = (c: Character): string =>
      `<span class="${c.isPlayer ? 'kf-player' : c.team === 'squad' ? 'kf-squad' : 'kf-bot'}">${c.name}</span>`;
    if (attacker) {
      attacker.kills++;
      this.hud.killFeed(via
        ? `${ns(attacker)} 用${via}淘汰了 ${ns(victim)}`
        : `${ns(attacker)} 淘汰了 ${ns(victim)}${head ? '（爆头）' : ''}`);
    } else {
      this.hud.killFeed(`${ns(victim)} 被安全区吞噬`);
    }
    if (victim.team === 'squad' && !victim.isPlayer) {
      this.hud.toast(`队友 ${victim.name} 被淘汰`);
    }
    if (attacker?.isPlayer) {
      this.audio.kill();
      this.hud.toast(`你淘汰了 ${victim.name}`);
    }
    this.hud.setCounts(this.aliveCount, this.player?.char.kills ?? 0);

    if (victim.isPlayer) {
      this.playerPlacement = placement;
      this.deathT = 1.6;
    } else {
      this.checkWin();
    }
  }

  private checkWin(): void {
    const player = this.player;
    if (!player || !player.char.alive || this.state !== 'playing') return;
    // 敌人全灭即胜(队友存活与否不限)
    for (const c of this.chars) {
      if (c.alive && c.team === 'enemy') return;
    }
    this.state = 'over';
    this.backpackOpen = false;
    this.hud.showBackpack(false);
    const stats: GameStats = {
      kills: player.char.kills,
      damage: this.damageDealt,
      timeSec: this.now,
      placement: 1,
    };
    this.hud.setWin(stats);
    this.hud.showScreen('win');
    this.hud.setCrosshair(0, false);
    this.hud.setScope(false);
    this.hud.setZoneTint(false);
    this.hud.setPickupPrompt(null);
    this.audio.kill();
    this.input.exitLock();
  }

  private finalizeDeath(): void {
    const player = this.player as PlayerController;
    this.state = 'over';
    this.backpackOpen = false;
    this.hud.showBackpack(false);
    const stats: GameStats = {
      kills: player.char.kills,
      damage: this.damageDealt,
      timeSec: this.now,
      placement: this.playerPlacement,
    };
    this.hud.setDeath(stats);
    this.hud.showScreen('death');
    this.hud.setCrosshair(0, false);
    this.hud.setScope(false);
    this.hud.setZoneTint(false);
    this.hud.setPickupPrompt(null);
    this.promptDoor = null;
    this.hud.setHealCast(-1);
    this.input.exitLock();
  }

  // ---- 拾取 ----

  // 玩家按 F: 优先开/关提示中的门, 否则拾取提示中的武器
  private playerPick(): void {
    const player = this.player;
    if (!player) return;
    // 载具优先(近驾驶座)
    if (this.promptVehicle) {
      player.enterVehicle(this.promptVehicle, this);
      this.promptVehicle = null;
      this.hud.setPickupPrompt(null);
      return;
    }
    const door = this.promptDoor;
    if (door && door.alive) {
      this.toggleDoor(door);
      this.promptDoor = null;
      this.hud.setPickupPrompt(null);
      return;
    }
    const item = this.promptItem;
    if (!item || !item.active) return;
    if (isArmorKind(item.kind)) this.tryPickupArmor(player.char, item);
    else if (isPackKind(item.kind)) this.tryPickupPack(player.char, item);
    else this.tryPickupWeapon(player.char, item);
    this.promptItem = null;
    this.hud.setPickupPrompt(null);
  }

  // F 拾取背包: 空槽直接装备; 已有则换下的旧包落地
  // 换更小背包时若当前负重超新容量 → 拒绝(超重换包不允许)
  tryPickupPack(c: Character, item: LootItem): boolean {
    const level = packLevelFromLoot(item.kind);
    if (!level) return false;
    if (c.isPlayer && carryWeight(c) > carryCapacity({ level })) {
      this.hud.toast('负重超出, 无法更换更小的背包');
      return false;
    }
    if (c.pack) {
      this.loot.spawn(packLootKind(c.pack.level), c.pos.x + rand(-0.6, 0.6), this.world.getHeight(c.pos.x, c.pos.z), c.pos.z + rand(-0.6, 0.6));
      if (c.isPlayer) this.hud.toast(`换下 ${PACKS[c.pack.level].name}`);
    }
    c.pack = { level };
    this.loot.consume(item);
    if (c.isPlayer) {
      this.hud.toast(`拾取 ${PACKS[level].name}`);
      this.audio.pickup();
    }
    return true;
  }

  // F 拾取护具: 空槽直接装备; 已有则换下的旧甲带剩余耐久落地
  tryPickupArmor(c: Character, item: LootItem): boolean {
    const info = armorFromLoot(item.kind);
    if (!info) return false;
    const def = ARMORS[info.kind][info.level];
    const cur = info.kind === 'helmet' ? c.helmet : c.vest;
    const durability = item.ammo > 0 ? item.ammo : def.maxDurability; // ammo 字段复用为耐久
    if (cur) {
      const curDef = ARMORS[info.kind][cur.level];
      this.loot.spawn(
        armorLootKind(info.kind, cur.level),
        c.pos.x + rand(-0.6, 0.6), this.world.getHeight(c.pos.x, c.pos.z), c.pos.z + rand(-0.6, 0.6),
        -1, Math.max(1, Math.round(cur.durability)),
      );
      if (c.isPlayer) this.hud.toast(`换下 ${curDef.name}`);
    }
    const state = { level: info.level, durability };
    if (info.kind === 'helmet') c.helmet = state;
    else c.vest = state;
    this.loot.consume(item);
    if (c.isPlayer) {
      this.hud.toast(`拾取 ${def.name}`);
      this.audio.pickup();
    }
    return true;
  }

  // 负重满提示(走近拾取每帧触发, 节流 2s)
  private capToastT = -10;
  private toastCapacityFull(): void {
    if (this.now - this.capToastT > 2) {
      this.capToastT = this.now;
      this.hud.toast('背包已满');
    }
  }

  // 空枪干打提示(节流 1.5s): 报所需弹种
  private dryToastT = -10;
  dryFireToast(t: AmmoType): void {
    if (this.now - this.dryToastT < 1.5) return;
    this.dryToastT = this.now;
    this.hud.toast(`没有子弹, 需要${AMMO_NAME[t]}`);
  }

  // 弹药/恢复品/投掷物: 走近自动拾取(玩家受负重限制, bot 不受限)
  applyAutoPickup(c: Character, item: LootItem): boolean {
    if (item.kind === 'frag' || item.kind === 'smoke') {
      const kind: ThrowableId = item.kind;
      const def = THROWABLES[kind];
      const stack = item.ammo > 0 ? item.ammo : 1; // ammo 字段复用为叠放数量
      const space = def.max - c.throwables[kind];
      if (space <= 0) return false;
      const unitW = THROW_WEIGHT[kind];
      const afford = c.isPlayer ? Math.floor((carryCapacity(c.pack) - carryWeight(c) + 1e-6) / unitW) : stack;
      const take = Math.min(space, stack, afford);
      if (take <= 0) {
        if (c.isPlayer) this.toastCapacityFull();
        return false;
      }
      c.throwables[kind] += take;
      if (take < stack) {
        item.ammo = stack - take; // 剩余留在地上
      } else {
        this.loot.consume(item);
      }
      if (c.isPlayer) {
        this.hud.toast(`拾取${def.name}${take > 1 ? `×${take}` : ''}（按 5 使用）`);
        this.audio.pickup();
      }
      return true;
    }
    // 分类弹药包: 按负重限量拾取, 剩余弹量留地
    const ammoT = ammoTypeFromLoot(item.kind);
    if (ammoT) {
      const n = item.ammo > 0 ? item.ammo : AMMO_BOX[ammoT];
      const weightLeft = c.isPlayer ? carryCapacity(c.pack) - carryWeight(c) : Infinity;
      const afford = Math.floor((weightLeft + 1e-6) / ROUND_WEIGHT);
      const take = Math.min(n, afford);
      if (take <= 0) {
        if (c.isPlayer) this.toastCapacityFull();
        return false;
      }
      c.ammo[ammoT] += take;
      if (take < n) {
        item.ammo = n - take;
      } else {
        this.loot.consume(item);
      }
      if (c.isPlayer) {
        this.hud.toast(`拾取${AMMO_NAME[ammoT]}${take < n ? ` (${take} 发)` : ''}`);
        this.audio.pickup();
      }
      return true;
    }
    if (item.kind === 'bandage' || item.kind === 'medkit' || item.kind === 'drink') {
      const def = HEALS[item.kind];
      const stack = item.ammo > 0 ? item.ammo : 1; // ammo 字段复用为叠放数量
      const space = def.max - c.heals[item.kind];
      if (space <= 0) return false; // 满了, 留在地上
      const afford = c.isPlayer
        ? Math.floor((carryCapacity(c.pack) - carryWeight(c) + 1e-6) / HEAL_WEIGHT[item.kind])
        : stack;
      const take = Math.min(space, stack, afford);
      if (take <= 0) {
        if (c.isPlayer) this.toastCapacityFull();
        return false;
      }
      c.heals[item.kind] += take;
      if (take < stack) {
        item.ammo = stack - take; // 剩余留在地上
      } else {
        this.loot.consume(item);
      }
      if (c.isPlayer) {
        this.hud.toast(`拾取${def.name}${take > 1 ? `×${take}` : ''} (X 使用)`);
        this.audio.pickup();
      }
      return true;
    }
    return false;
  }

  // 拾取武器/近战(bot 走近自动调用, 玩家按 F 调用)
  tryPickupWeapon(c: Character, item: LootItem): boolean {
    if (!item.active) return false;
    const kind = item.kind;
    if (kind === 'knife') {
      if (c.melee.def.id === 'knife') return false;
      c.melee = { def: MELEE.knife };
      if (!c.hasGun()) c.curSlot = 3;
      this.loot.consume(item);
      if (c.isPlayer) {
        this.hud.toast(`拾取 ${MELEE.knife.name}`);
        this.audio.pickup();
      }
      return true;
    }
    if (!isWeaponKind(kind)) return false;

    const def = WEAPONS[kind];
    // 目标栏位
    let slot: number;
    if (def.id === 'pistol') {
      slot = 2;
    } else if (!c.guns[0]) {
      slot = 0;
    } else if (!c.guns[1]) {
      slot = 1;
    } else if (c.isPlayer && (c.curSlot === 0 || c.curSlot === 1)) {
      slot = c.curSlot; // 玩家手持主武器时替换当前
    } else {
      // 替换品级较低的主武器
      const t0 = c.guns[0]?.def.tier ?? 99;
      const t1 = c.guns[1]?.def.tier ?? 99;
      slot = t0 <= t1 ? 0 : 1;
    }
    // 手枪位被占 → 替换并掉落旧枪
    const old = c.guns[slot];
    if (old) {
      this.loot.spawn(old.def.id, c.pos.x + rand(-0.6, 0.6), this.world.getHeight(c.pos.x, c.pos.z), c.pos.z + rand(-0.6, 0.6), old.mag, 0);
    }
    c.guns[slot] = { def, mag: item.mag >= 0 ? item.mag : def.magSize };
    c.ammo[def.ammo] += Math.max(0, item.ammo);
    c.curSlot = slot;
    this.loot.consume(item);
    if (c.isPlayer) {
      this.hud.toast(`拾取 ${def.name}`);
      this.audio.pickup();
    }
    return true;
  }

  // ---- HUD / 小地图 ----

  private refreshHud(): void {
    const player = this.player as PlayerController;
    const c = player.char;
    this.hud.setHP(c.hp);
    this.hud.setHeals(`绷带×${c.heals.bandage}  医疗包×${c.heals.medkit}  饮料×${c.heals.drink}`);
    // 空降仪表与提示
    if (player.descent) {
      const agl = c.pos.y - this.world.getHeight(c.pos.x, c.pos.z);
      this.hud.setAltitude(agl, player.vy);
      if (player.descent === 'plane') this.hud.setPickupPrompt('按 F 跳伞');
      else if (player.descent === 'freefall' && agl < 150) this.hud.setPickupPrompt('按 Space 开伞');
      else this.hud.setPickupPrompt(null); // 开伞后清除
    } else {
      this.hud.setAltitude(-1, 0);
    }
    // 小队面板(玩家高亮, 变化才刷新)
    this.hud.setSquad([
      { name: '你', hp: c.hp, alive: c.alive, isPlayer: true },
      ...this.mates.map((m) => ({ name: m.char.name, hp: m.char.hp, alive: m.char.alive, isPlayer: false })),
    ]);
    // 载具仪表(驾驶中显示)
    if (player.driving) {
      const v = player.driving;
      this.hud.setVehicle(Math.abs(v.speed) * 3.6, v.hp / VEHICLE_SPEC[v.kind].hp);
    } else {
      this.hud.setVehicle(-1, 0);
    }
    const gun = c.heldGun();
    const noAmmo = gun !== null && gun.mag <= 0 && c.ammo[gun.def.ammo] <= 0;
    this.hud.setNoAmmo(noAmmo);
    if (c.curSlot === 3) {
      this.hud.setWeapon(c.melee.def.name, '—', '', '近战');
    } else if (c.curSlot === 4) {
      const td = THROWABLES[c.throwKind];
      this.hud.setWeapon(td.name, `×${c.throwables[c.throwKind]}`, '', '按住左键蓄力');
    } else if (gun) {
      this.hud.setWeapon(
        gun.def.name,
        player.reloading ? '--' : String(gun.mag),
        noAmmo ? '无弹' : `/ ${c.ammo[gun.def.ammo]}`,
        player.reloading ? '换弹中…' : gun.def.auto ? '全自动' : '半自动',
      );
    } else {
      this.hud.setWeapon('空', '—', '', '');
    }

    const names: (string | null)[] = [
      c.guns[0]?.def.name.split(' ')[0] ?? null,
      c.guns[1]?.def.name.split(' ')[0] ?? null,
      c.guns[2]?.def.name.split(' ')[0] ?? null,
      c.melee.def.name,
      `${THROWABLES[c.throwKind].name}×${c.throwables[c.throwKind]}`,
    ];
    const key = `${names.join(',')}|${c.curSlot}`;
    if (key !== this.hudSlotsKey) {
      this.hudSlotsKey = key;
      this.hud.setSlots(names, c.curSlot);
    }

    // 护具栏(耐久变化才刷新 DOM)
    const aKey = `${c.helmet?.level ?? 0}:${Math.ceil(c.helmet?.durability ?? 0)}|${c.vest?.level ?? 0}:${Math.ceil(c.vest?.durability ?? 0)}`;
    if (aKey !== this.hudArmorKey) {
      this.hudArmorKey = aKey;
      this.hud.setArmor(c.helmet, c.vest);
    }

    // 毒圈状态
    const outside = this.zone.isOutside(c.pos.x, c.pos.z);
    if (outside && c.alive) {
      this.hud.setZoneStatus(`你在圈外！尽快移动 (-${this.zone.dps}/s)`, true);
    } else {
      this.hud.setZoneStatus(this.zone.statusText(), this.zone.state === 'shrink');
    }
    this.hud.setZoneTint(outside && c.alive);

    // 准星: 弧度→像素; AWM 开镜时换全屏瞄准镜
    const sizeH = this.renderer.domElement.height / this.renderer.getPixelRatio();
    const focal = sizeH / 2 / Math.tan((player.camera.fov * Math.PI) / 360);
    const px = Math.tan(player.spreadRad) * focal;
    const scoped = this.state === 'playing' && c.alive && player.aiming && gun?.def.id === 'sniper';
    this.hud.setScope(scoped);
    this.hud.setCrosshair(this.state === 'playing' && c.alive ? px + 6 : 0, this.state === 'playing' && c.alive && !scoped);
  }

  private refreshMinimap(): void {
    const player = this.player as PlayerController;
    let n = 0;
    for (const b of this.bots) {
      if (b.char.alive && this.now - b.char.lastShotT < 2) {
        const d = this.shotDots[n] as { x: number; z: number };
        d.x = b.char.pos.x;
        d.z = b.char.pos.z;
        n++;
      }
    }
    for (let i = 0; i < this.vehicles.list.length; i++) {
      const v = this.vehicles.list[i] as Vehicle;
      const m = this.mapVehicles[i] as { x: number; z: number; dead: boolean };
      m.x = v.pos.x;
      m.z = v.pos.z;
      m.dead = v.dead;
    }
    for (let i = 0; i < this.mates.length; i++) {
      const c = (this.mates[i] as TeammateController).char;
      const s = this.mapSquad[i] as { x: number; z: number };
      s.x = c.pos.x;
      s.z = c.pos.z;
    }
    this.minimap.draw(this.zone, player.char.pos.x, player.char.pos.z, player.yaw, this.shotDots, n, this.mapVehicles, this.mapSquad);
  }
}
