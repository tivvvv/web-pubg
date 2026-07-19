// ─────────────────────────────────────────────────────────────────────────────
// airdrop.ts — 空投补给系统: 定期运输机过顶投放补给箱(红白伞/红烟柱/高级物资)
// 与航线飞机独立: 自带单架复用飞机; 箱子/伞盖/烟柱全部池化复用, 重开清零
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { buildTransportPlane } from './planemodel';
import { WATER_Y, type Platform, type World } from './world';
import { AMMO_LOOT_KIND, WEAPONS } from './weapons';
import { rand, clamp } from './utils';
import type { AabbCollider } from './types';
import type { Game } from './game';

const PLANE_H = 200;      // 过顶高度(与航线一致)
const PLANE_SPEED = 92;   // m/s
const FALL_SPEED = 8;     // 箱子下落 m/s
const SMOKE_TIME = 60;    // 红烟持续时间(s)
const INTEREST_TIME = 45; // bot 兴趣窗口(s)
const INTEREST_DIST = 120; // bot 好奇半径(m)
const MAX_DROPS = 3;

export interface Crate {
  group: THREE.Group;
  lid: THREE.Group;       // 铰链盖(开启时翻转)
  canopy: THREE.Group;    // 红白降落伞(落地隐藏)
  pos: THREE.Vector3;
  state: 'idle' | 'falling' | 'landed' | 'opened';
  collider: AabbCollider | null;
  platform: Platform | null;
  driftX: number;
  driftZ: number;
  smokeT: number;         // 剩余红烟时间
  landT: number;          // 落地时刻(game.now)
  lidT: number;           // 开盖动画 0..1
}

// 共享几何/材质
const CRATE_GEO = new THREE.BoxGeometry(1.3, 1.0, 1.3);
const LID_GEO = new THREE.BoxGeometry(1.3, 0.16, 1.3);
const STRAP_GEO = new THREE.BoxGeometry(1.34, 0.12, 0.3);
const PANEL_GEO = new THREE.BoxGeometry(2.4, 0.18, 1.7);
const LINE_GEO = new THREE.BoxGeometry(0.03, 2.6, 0.03);
const MAT = {
  crate: new THREE.MeshLambertMaterial({ color: 0x5a6b4a }),
  lid: new THREE.MeshLambertMaterial({ color: 0x4a5a3e }),
  strap: new THREE.MeshLambertMaterial({ color: 0x2f3327 }),
  canopyR: new THREE.MeshLambertMaterial({ color: 0xc23a2e }),
  canopyW: new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
  line: new THREE.MeshLambertMaterial({ color: 0xcccccc }),
  smoke: new THREE.MeshBasicMaterial({
    color: 0xe03a2e, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }),
};

function buildCrateKit(): Crate {
  const group = new THREE.Group();
  const body = new THREE.Mesh(CRATE_GEO, MAT.crate);
  body.castShadow = true;
  group.add(body);
  const strap = new THREE.Mesh(STRAP_GEO, MAT.strap);
  group.add(strap);
  const lid = new THREE.Group();
  lid.position.set(0, 0.5, -0.65); // 铰链在顶后沿
  const lidMesh = new THREE.Mesh(LID_GEO, MAT.lid);
  lidMesh.position.set(0, 0.08, 0.65);
  lidMesh.castShadow = true;
  lid.add(lidMesh);
  group.add(lid);
  // 红白伞盖(三片, 比人物伞大一号)
  const canopy = new THREE.Group();
  const mkPanel = (x: number, rz: number, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(PANEL_GEO, mat);
    m.position.set(x, 0, 0);
    m.rotation.z = rz;
    m.castShadow = true;
    canopy.add(m);
    return m;
  };
  mkPanel(-2.2, 0.34, MAT.canopyR);
  mkPanel(0, 0, MAT.canopyW);
  mkPanel(2.2, -0.34, MAT.canopyR);
  for (const [lx, lz] of [[-2.9, -0.8], [-2.9, 0.8], [2.9, -0.8], [2.9, 0.8]] as const) {
    const line = new THREE.Mesh(LINE_GEO, MAT.line);
    line.position.set(lx * 0.6, -1.4, lz);
    line.rotation.z = lx > 0 ? 0.45 : -0.45;
    line.rotation.x = lz > 0 ? 0.2 : -0.2;
    canopy.add(line);
  }
  canopy.position.set(0, 3.6, 0);
  group.add(canopy);
  group.visible = false;
  return {
    group, lid, canopy, pos: new THREE.Vector3(),
    state: 'idle', collider: null, platform: null,
    driftX: 0, driftZ: 0, smokeT: 0, landT: 0, lidT: 0,
  };
}

export class AirdropManager {
  private game: Game;
  private world: World;
  private plane: { group: THREE.Group; props: THREE.Object3D[] } | null = null;
  private planeDir = new THREE.Vector3(1, 0, 0);
  private planeS = -1;          // 沿程里程(m)
  private planeDur = 0;
  private dropPoint = new THREE.Vector3();
  private released = false;
  private crates: Crate[] = [];
  private nextDropT = Infinity;
  private jumpT = -1;
  private dropCount = 0;
  private interested = new Set<number>(); // 最近一箱感兴趣的 bot char id
  private smokeColumn: THREE.Mesh;
  private smokeAcc = 0;
  private tmpV = new THREE.Vector3();
  private planeKit: { group: THREE.Group; props: THREE.Object3D[] } | null = null;

  constructor(game: Game, scene: THREE.Scene) {
    this.game = game;
    this.world = game.world;
    this.smokeColumn = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 42, 10, 1, true), MAT.smoke);
    this.smokeColumn.visible = false;
    this.smokeColumn.frustumCulled = false;
    this.smokeColumn.renderOrder = 6;
    scene.add(this.smokeColumn);
    for (let i = 0; i < MAX_DROPS; i++) {
      const c = buildCrateKit();
      this.crates.push(c);
      scene.add(c.group);
    }
  }

  // 活跃(落地未开)的空投点(bot/小地图用)
  private activeCrate(): Crate | null {
    for (const c of this.crates) {
      if (c.state === 'landed') return c;
    }
    return null;
  }

  // bot 好奇点: 感兴趣窗口内且被抽中的 bot 返回落点, 否则 null
  investigatePoint(charId: number): { x: number; z: number } | null {
    const c = this.activeCrate();
    if (!c) return null;
    if (this.game.now - c.landT > INTEREST_TIME) return null;
    if (!this.interested.has(charId)) return null;
    return c.pos;
  }

  // 小地图图标(冒烟中的落地未开空投)
  icon(): { x: number; z: number } | null {
    const c = this.activeCrate();
    return c && c.smokeT > 0 ? c.pos : null;
  }

  // F 交互: 最近的落地未开空投
  nearestClosedCrate(x: number, y: number, z: number, maxD: number): Crate | null {
    let best: Crate | null = null;
    let bestD = maxD * maxD;
    for (const c of this.crates) {
      if (c.state !== 'landed') continue;
      const dx = c.pos.x - x;
      const dy = c.pos.y + 0.5 - y;
      const dz = c.pos.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }
    return best;
  }

  // 打开空投: 开盖 + 嘶声 + 高级物资扇形落位(地面正常拾取流)
  open(crate: Crate): void {
    if (crate.state !== 'landed') return;
    crate.state = 'opened';
    crate.smokeT = 0; // 开过后烟/图标停止(已舔标记)
    this.game.soundAt(crate.pos, (d, p) => this.game.audio.hiss(d, p));
    // 保底高级套: 狙击或步枪(满弹匣) + 1~2 盒匹配弹药 + 三级甲 + 医疗箱 + 概率饮料/手雷
    const gunKind = Math.random() < 0.5 ? 'sniper' : 'rifle';
    const gdef = WEAPONS[gunKind];
    const items: { kind: import('./types').LootKind; mag?: number }[] = [
      { kind: gunKind, mag: gdef.magSize },
      { kind: AMMO_LOOT_KIND[gdef.ammo] },
      { kind: Math.random() < 0.5 ? 'helmet3' : 'vest3' },
      { kind: 'medkit' },
    ];
    if (Math.random() < 0.5) items.push({ kind: AMMO_LOOT_KIND[gdef.ammo] });
    if (Math.random() < 0.6) items.push({ kind: 'drink' });
    if (Math.random() < 0.4) items.push({ kind: 'frag' });
    for (let i = 0; i < items.length; i++) {
      const a = (i / items.length) * Math.PI * 2 + Math.random() * 0.6;
      const r = 1.6 + Math.random() * 0.7;
      const x = crate.pos.x + Math.cos(a) * r;
      const z = crate.pos.z + Math.sin(a) * r;
      const it = items[i] as { kind: import('./types').LootKind; mag?: number };
      this.game.loot.spawn(it.kind, x, this.world.getHeight(x, z), z, it.mag ?? -1, 0);
    }
  }

  update(dt: number): void {
    const g = this.game;
    // 排程: 跳伞后 70s 首投, 之后每 75~90s, 最多 3 次; 圈 <80m 停投
    if (!g.zoneArmed) return;
    if (this.jumpT < 0) {
      this.jumpT = g.now;
      this.nextDropT = this.jumpT + 70;
    }
    if (this.dropCount < MAX_DROPS && g.now >= this.nextDropT && g.zone.radius > 80) {
      this.startPass();
      this.dropCount++;
      this.nextDropT = g.now + rand(75, 90);
    }
    // 飞机过顶
    if (this.plane) {
      this.planeS += PLANE_SPEED * dt;
      const t = this.planeS;
      this.tmpV.copy(this.dropPoint).addScaledVector(this.planeDir, t - 650);
      this.tmpV.y = PLANE_H - 1.1;
      this.plane.group.position.copy(this.tmpV);
      this.plane.group.rotation.y = Math.atan2(this.planeDir.x, this.planeDir.z);
      for (const p of this.plane.props) p.rotation.z += dt * 34;
      // 到点上空投下
      if (!this.released && t >= 650) {
        this.released = true;
        this.releaseCrate();
      }
      // 引擎声按玩家距离衰减
      const cam = g.playerCtl?.camera;
      if (cam) {
        const d = this.tmpV.distanceTo(cam.position);
        g.audio.planeDroneSet(clamp(1.5 / (1 + d * 0.012), 0, 0.7));
      }
      if (t >= this.planeDur) {
        g.scene.remove(this.plane.group);
        this.plane = null;
        g.audio.planeDroneStop();
      }
    }
    // 箱子: 下落/落地/开盖动画
    for (const c of this.crates) {
      if (c.state === 'falling') {
        c.pos.x += c.driftX * dt;
        c.pos.z += c.driftZ * dt;
        c.pos.y -= FALL_SPEED * dt;
        const gh = this.world.groundHeight(c.pos.x, c.pos.z, c.pos.y + 1);
        if (c.pos.y - 0.5 <= gh) {
          c.pos.y = gh + 0.5;
          this.land(c, gh);
        }
        c.group.position.copy(c.pos);
      } else if (c.state === 'opened' && c.lidT < 1) {
        c.lidT = Math.min(1, c.lidT + dt * 2.2);
        c.lid.rotation.x = -1.9 * c.lidT;
      }
      // 红烟柱
      if (c.state === 'landed' && c.smokeT > 0) {
        c.smokeT -= dt;
        this.smokeColumn.visible = c.smokeT > 0;
        this.smokeColumn.position.set(c.pos.x, c.pos.y + 21, c.pos.z);
        this.smokeColumn.rotation.y += dt * 0.4;
        this.smokeAcc += dt;
        if (this.smokeAcc > 0.35) {
          this.smokeAcc = 0;
          this.tmpV.set(c.pos.x, c.pos.y + 0.6, c.pos.z);
          g.effects.burst(this.tmpV, 4, 0.9, 0.2, 0.16, 4.5);
        }
      }
    }
  }

  // 选点(圈内偏陆) + 直线过顶航线
  private startPass(): void {
    const g = this.game;
    // 圈内随机点, 拒绝深水(最多 20 次, 兜底向圈心收)
    let px = g.zone.center.x;
    let pz = g.zone.center.y;
    for (let t = 0; t < 20; t++) {
      g.zone.randomPointInside(g.tmpV2, 0.85);
      px = g.tmpV2.x;
      pz = g.tmpV2.y;
      if (this.world.getHeight(px, pz) > WATER_Y + 0.3) break;
      px = (px + g.zone.center.x) / 2;
      pz = (pz + g.zone.center.y) / 2;
      if (this.world.getHeight(px, pz) > WATER_Y + 0.3) break;
    }
    this.dropPoint.set(px, PLANE_H, pz);
    const ang = Math.random() * Math.PI * 2;
    this.planeDir.set(Math.cos(ang), 0, Math.sin(ang));
    if (!this.plane) {
      if (!this.planeKit) this.planeKit = buildTransportPlane();
      this.plane = this.planeKit;
      g.scene.add(this.plane.group);
    }
    this.planeS = 0;
    this.planeDur = 1300;
    this.released = false;
    g.hud.toast('空投已投放, 注意天空');
    g.audio.warn();
  }

  // 投放一个空闲箱(漂移向量按预计落点选, 避免漂进深水)
  private releaseCrate(): void {
    const c = this.crates.find((k) => k.state === 'idle');
    if (!c) return;
    c.state = 'falling';
    c.pos.copy(this.dropPoint);
    c.pos.y = PLANE_H - 2.5;
    const gh = this.world.getHeight(c.pos.x, c.pos.z);
    const fallT = Math.max(1, (PLANE_H - gh) / FALL_SPEED);
    c.driftX = 0;
    c.driftZ = 0;
    for (let t = 0; t < 8; t++) {
      const da = Math.random() * Math.PI * 2;
      const sp = rand(0.4, 1.2);
      const lx = c.pos.x + Math.cos(da) * sp * fallT;
      const lz = c.pos.z + Math.sin(da) * sp * fallT;
      if (this.world.getHeight(lx, lz) > WATER_Y + 0.3) {
        c.driftX = Math.cos(da) * sp;
        c.driftZ = Math.sin(da) * sp;
        break;
      }
    }
    c.group.visible = true;
    c.canopy.visible = true;
    c.lid.rotation.x = 0;
    c.lidT = 0;
    c.group.position.copy(c.pos);
  }

  // 落地: 收伞 + 实心碰撞(挡人挡弹) + 可站上平台 + 红烟 + bot 兴趣
  private land(c: Crate, gh: number): void {
    const g = this.game;
    c.state = 'landed';
    c.landT = g.now;
    c.canopy.visible = false;
    c.smokeT = SMOKE_TIME;
    this.tmpV.set(c.pos.x, gh + 0.8, c.pos.z);
    g.effects.burst(this.tmpV, 10, 0.75, 0.72, 0.68, 3);
    const col: AabbCollider = {
      kind: 'aabb',
      minX: c.pos.x - 0.65, maxX: c.pos.x + 0.65,
      minY: gh - 0.1, maxY: gh + 1.0,
      minZ: c.pos.z - 0.65, maxZ: c.pos.z + 0.65,
      tag: 'wall',
    };
    this.world.addCollider(col);
    c.collider = col;
    const pf: Platform = {
      minX: col.minX, maxX: col.maxX, minZ: col.minZ, maxZ: col.maxZ, top: gh + 1.0,
    };
    this.world.platforms.push(pf);
    c.platform = pf;
    // bot 好奇: 120m 内最近 4 个活 bot
    this.interested.clear();
    const near = g.bots
      .filter((b) => b.char.alive)
      .map((b) => ({ b, d: Math.hypot(b.char.pos.x - c.pos.x, b.char.pos.z - c.pos.z) }))
      .filter((e) => e.d < INTEREST_DIST)
      .sort((a, b2) => a.d - b2.d)
      .slice(0, 4);
    for (const e of near) this.interested.add(e.b.char.id);
  }

  // 重开清零(无残留飞机/箱子/烟柱/碰撞)
  reset(): void {
    if (this.plane) {
      this.game.scene.remove(this.plane.group);
      this.plane = null;
      this.game.audio.planeDroneStop();
    }
    for (const c of this.crates) {
      c.state = 'idle';
      c.group.visible = false;
      c.canopy.visible = true;
      c.lid.rotation.x = 0;
      c.smokeT = 0;
      if (c.collider) {
        c.collider.off = true;
        c.collider = null;
      }
      if (c.platform) {
        const i = this.world.platforms.indexOf(c.platform);
        if (i >= 0) this.world.platforms.splice(i, 1);
        c.platform = null;
      }
    }
    this.smokeColumn.visible = false;
    this.interested.clear();
    this.jumpT = -1;
    this.dropCount = 0;
    this.nextDropT = Infinity;
    this.planeS = -1;
  }
}
