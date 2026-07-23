// ─────────────────────────────────────────────────────────────────────────────
// vehicles.ts - 载具系统: 汽车(吉普)/摩托车 生成/模型/射线/损毁/残骸
// 玩家和机器人共用街机驾驶运动学; 这里同时管理对象/模型/命中/爆炸熄火
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { WATER_Y, WORLD_HALF, type World } from './world';
import type { Character } from './character';
import type { Game } from './game';
import { clamp, lerp } from './utils';

export type VehicleKind = 'car' | 'moto' | 'buggy';

export interface VehicleSpec {
  hp: number;
  seats: number;
  radius: number;   // 碰撞圆半径
  accel: number;
  vmax: number;
  steer: number;    // 基础转向速率 rad/s
  brake: number;
  revMax: number;
  half: [number, number, number]; // OBB 半尺寸(宽/高/长)
  seat: [number, number, number]; // 驾驶座局部偏移
}

export const VEHICLE_SPEC: Record<VehicleKind, VehicleSpec> = {
  // seat.y 是角色根节点高度；髋部在根节点上方 0.74m，不能直接填写座垫表面高度。
  car: { hp: 800, seats: 4, radius: 1.4, accel: 9.5, vmax: 22, steer: 1.8, brake: 15, revMax: 7, half: [0.85, 0.8, 1.7], seat: [-0.5, 0.18, 0.15] },
  moto: { hp: 400, seats: 2, radius: 0.9, accel: 12, vmax: 27, steer: 2.5, brake: 17, revMax: 6, half: [0.4, 0.7, 1.05], seat: [0, 0.08, -0.15] },
  buggy: { hp: 560, seats: 2, radius: 1.15, accel: 11, vmax: 25, steer: 2.15, brake: 16, revMax: 7, half: [0.75, 0.8, 1.35], seat: [-0.28, 0.13, -0.1] },
};

interface SpawnDef { kind: VehicleKind; x: number; z: number; yaw: number }
export const VEHICLE_SPAWNS: readonly SpawnDef[] = [
  { kind: 'car', x: -52, z: -12, yaw: 0.4 },   // 城区街道
  { kind: 'car', x: -24, z: 192, yaw: 1.2 },   // 农场
  { kind: 'car', x: 168, z: -52, yaw: -0.6 },  // 竞技场边
  { kind: 'car', x: 198, z: -212, yaw: 2.4 },  // 渔村
  { kind: 'moto', x: -72, z: -32, yaw: 0.9 },  // 城区
  { kind: 'moto', x: -56, z: 208, yaw: -0.3 }, // 农场
  { kind: 'moto', x: -52, z: 62, yaw: 1.7 },   // 桥边
  { kind: 'buggy', x: -216, z: 28, yaw: 0.35 },  // 鹰脊哨站
  { kind: 'buggy', x: 220, z: -186, yaw: -0.7 }, // 渔港外沿
  { kind: 'buggy', x: 210, z: -34, yaw: 1.25 }, // 竞技场公路
  { kind: 'moto', x: 18, z: -150, yaw: 2.7 }, // 林场南侧转移线
];

const CAR_COLORS = [0x6a7a52, 0x8a4a3a, 0x8a8578, 0x4a5e6e];
const MOTO_COLORS = [0xa03a30, 0x3a6ea5, 0x555555];

// 座位表: 0=驾驶位, 1..N=乘客位
const SEATS: Record<VehicleKind, [number, number, number][]> = {
  car: [VEHICLE_SPEC.car.seat, [0.5, 0.18, 0.15], [-0.5, 0.18, -0.75], [0.5, 0.18, -0.75]],
  moto: [VEHICLE_SPEC.moto.seat, [0, 0.08, 0.45]],
  buggy: [VEHICLE_SPEC.buggy.seat, [0.28, 0.13, -0.1]],
};

// 驾驶座世界坐标(= seatWorldAt idx 0)
export function seatWorld(v: Vehicle, out: THREE.Vector3): THREE.Vector3 {
  return seatWorldAt(v, 0, out);
}

// 任意座位世界坐标
export function seatWorldAt(v: Vehicle, idx: number, out: THREE.Vector3): THREE.Vector3 {
  const table = SEATS[v.kind];
  const s = table[Math.min(idx, table.length - 1)];
  const sin = Math.sin(v.yaw);
  const cos = Math.cos(v.yaw);
  out.set(v.pos.x + s[0] * cos + s[2] * sin, v.pos.y + s[1], v.pos.z - s[0] * sin + s[2] * cos);
  return out;
}

export interface VehicleDriveControls {
  throttle: number;
  steer: number;
  handbrake?: boolean;
}

export interface VehicleDriveResult {
  collision: boolean;
  stalled: boolean;
  impactSpeed: number;
  distance: number;
}

// Shared vehicle movement for player and bot drivers.
export function driveVehicleStep(
  v: Vehicle,
  driver: Character,
  controls: VehicleDriveControls,
  dt: number,
  game: Game,
): VehicleDriveResult {
  const spec = VEHICLE_SPEC[v.kind];
  const throttle = clamp(controls.throttle, -1, 1);
  const steerIn = clamp(controls.steer, -1, 1);
  if (throttle > 0) {
    v.speed += spec.accel * throttle * dt;
  } else if (throttle < 0) {
    if (v.speed > 0.5) v.speed -= spec.brake * -throttle * dt;
    else v.speed -= spec.accel * 0.5 * -throttle * dt;
  }
  v.speed -= v.speed * 0.4 * dt;
  if (Math.abs(throttle) < 0.01) {
    v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 1.0 * dt);
  }
  if (controls.handbrake) {
    v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 20 * dt);
  }
  v.speed = clamp(v.speed, -spec.revMax, spec.vmax);

  const auth = 1 - Math.min(0.75, (Math.abs(v.speed) / spec.vmax) * 0.75);
  v.yaw += steerIn * spec.steer * auth * (v.speed >= 0 ? 1 : -1) * dt;
  const oldX = v.pos.x;
  const oldZ = v.pos.z;
  v.pos.x += Math.sin(v.yaw) * v.speed * dt;
  v.pos.z += Math.cos(v.yaw) * v.speed * dt;
  const impactSpeed = Math.abs(v.speed);
  const collision = game.world.resolveVehicle(v.pos, spec.radius);
  if (collision) {
    if (impactSpeed > 12) {
      game.vehicles.damage(v, impactSpeed * 6);
      game.soundAt(v.pos, (distance, pan) => game.audio.vehicleImpact(distance, pan));
      game.addShakeFrom(v.pos);
    }
    v.speed *= 0.55;
  }
  v.pos.x = clamp(v.pos.x, -WORLD_HALF + 2, WORLD_HALF - 2);
  v.pos.z = clamp(v.pos.z, -WORLD_HALF + 2, WORLD_HALF - 2);

  const groundY = game.world.groundHeight(v.pos.x, v.pos.z, v.pos.y + 1);
  v.pos.y = groundY;
  const sin = Math.sin(v.yaw);
  const cos = Math.cos(v.yaw);
  const radius = spec.radius;
  const groundFront = game.world.getHeight(v.pos.x + sin * radius, v.pos.z + cos * radius);
  const groundBack = game.world.getHeight(v.pos.x - sin * radius, v.pos.z - cos * radius);
  const groundLeft = game.world.getHeight(v.pos.x + cos * radius, v.pos.z - sin * radius);
  const groundRight = game.world.getHeight(v.pos.x - cos * radius, v.pos.z + sin * radius);
  const targetPitch = Math.atan2(groundBack - groundFront, 2 * radius);
  const targetRoll = Math.atan2(groundRight - groundLeft, 2 * radius);
  v.pitch = lerp(v.pitch, clamp(targetPitch, -0.4, 0.4), Math.min(1, dt * 8));
  v.roll = lerp(v.roll, clamp(targetRoll, -0.4, 0.4), Math.min(1, dt * 8));
  v.spinWheels(dt, steerIn);

  if (groundY < WATER_Y - 0.05) {
    game.vehicles.stall(v, game);
    return {
      collision,
      stalled: true,
      impactSpeed,
      distance: Math.hypot(v.pos.x - oldX, v.pos.z - oldZ),
    };
  }
  if (Math.abs(v.speed) > 6) game.runOverCheck(v, driver);
  seatWorld(v, driver.pos);
  driver.yaw = v.yaw;
  driver.speed2d = Math.abs(v.speed);
  return {
    collision,
    stalled: false,
    impactSpeed,
    distance: Math.hypot(v.pos.x - oldX, v.pos.z - oldZ),
  };
}

export class Vehicle {
  speed = 0;             // 有符号速度(倒挡为负)
  hp: number;
  driver: Character | null = null;
  claimedBy: Character | null = null;
  passengers: (Character | null)[] = []; // 乘客位(任务9 队友)
  dead = false;          // 熄火/残骸(不可再驾驶)
  exploded = false;
  burnT = -1;            // 燃烧计时(2s 后爆炸)
  yaw: number;
  pitch = 0;
  roll = 0;
  fireT = 0;
  readonly kind: VehicleKind;
  readonly pos: THREE.Vector3;
  readonly group = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private steerWheels: THREE.Object3D[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];

  constructor(kind: VehicleKind, pos: THREE.Vector3, yaw0: number) {
    this.kind = kind;
    this.pos = pos;
    this.yaw = yaw0;
    this.hp = VEHICLE_SPEC[kind].hp;
    this.passengers = new Array(VEHICLE_SPEC[kind].seats - 1).fill(null);
    this.buildModel();
    this.sync();
  }

  private buildModel(): void {
    const g = this.group;
    if (this.kind === 'car') {
      const bodyC = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] as number;
      const body = this.mat(bodyC);
      const dark = this.mat(0x2e2e2e);
      const frame = this.mat(0x3a3f35);
      const glass = this.mat(0x9fc4d8);
      glass.transparent = true;
      glass.opacity = 0.4;
      const lampF = this.mat(0xfff0b8);
      const lampR = this.mat(0xc23a2e);
      const hub = this.mat(0x8a8f96);
      const add = (geo: THREE.BoxGeometry, m: THREE.MeshStandardMaterial, x: number, y: number, z: number, rx = 0): THREE.Mesh => {
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.set(x, y, z);
        mesh.rotation.x = rx;
        mesh.castShadow = true;
        g.add(mesh);
        return mesh;
      };
      // 底盘/引擎盖/座舱框架/车顶/防滚架
      add(new THREE.BoxGeometry(1.6, 0.55, 3.1), body, 0, 0.62, 0);
      add(new THREE.BoxGeometry(1.5, 0.3, 1.0), body, 0, 0.86, 1.15);
      for (const [px, pz] of [[-0.72, 0.55], [0.72, 0.55], [-0.72, -0.75], [0.72, -0.75]] as const) {
        add(new THREE.BoxGeometry(0.09, 0.85, 0.09), frame, px, 1.32, pz);
      }
      add(new THREE.BoxGeometry(1.55, 0.09, 1.7), body, 0, 1.78, -0.1);
      add(new THREE.BoxGeometry(1.4, 0.5, 0.08), frame, 0, 1.25, -0.85);
      // 挡风玻璃(框在立柱上, 玻璃微透)
      add(new THREE.BoxGeometry(1.36, 0.52, 0.05), glass, 0, 1.34, 0.56, -0.12);
      // 前脸: 格栅/大灯/前杠; 尾部: 尾灯/后杠/备胎
      add(new THREE.BoxGeometry(0.95, 0.2, 0.06), dark, 0, 0.6, 1.58);
      add(new THREE.BoxGeometry(0.2, 0.12, 0.06), lampF, -0.55, 0.74, 1.57);
      add(new THREE.BoxGeometry(0.2, 0.12, 0.06), lampF, 0.55, 0.74, 1.57);
      add(new THREE.BoxGeometry(1.55, 0.12, 0.1), dark, 0, 0.4, 1.62);
      add(new THREE.BoxGeometry(0.16, 0.1, 0.05), lampR, -0.6, 0.66, -1.56);
      add(new THREE.BoxGeometry(0.16, 0.1, 0.05), lampR, 0.6, 0.66, -1.56);
      add(new THREE.BoxGeometry(1.5, 0.12, 0.1), dark, 0, 0.4, -1.62);
      const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.18, 10), dark);
      spare.rotation.z = Math.PI / 2;
      spare.position.set(0, 1.05, -1.66);
      spare.castShadow = true;
      g.add(spare);
      // 后视镜 ×2
      add(new THREE.BoxGeometry(0.06, 0.12, 0.14), dark, -0.82, 1.48, 0.52);
      add(new THREE.BoxGeometry(0.06, 0.12, 0.14), dark, 0.82, 1.48, 0.52);
      // 座舱: 双前座/后排/方向盘
      add(new THREE.BoxGeometry(0.5, 0.42, 0.45), dark, -0.42, 0.98, 0.1);
      add(new THREE.BoxGeometry(0.5, 0.42, 0.45), dark, 0.42, 0.98, 0.1);
      add(new THREE.BoxGeometry(1.25, 0.4, 0.4), dark, 0, 0.98, -0.72);
      const wheel0 = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 10), dark);
      wheel0.position.set(-0.5, 1.18, 0.42);
      wheel0.rotation.x = -0.9;
      wheel0.castShadow = true;
      g.add(wheel0);
      add(new THREE.BoxGeometry(0.06, 0.2, 0.06), dark, -0.5, 1.06, 0.46);
      // 轮(前可转向): 轮胎 + 侧壁圈 + 轮毂盖
      const sidewallGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.24, 10);
      const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.27, 8);
      for (const [wx, wz, front] of [[-0.82, 1.0, 1], [0.82, 1.0, 1], [-0.82, -1.0, 0], [0.82, -1.0, 0]] as const) {
        const w = new THREE.Group();
        w.position.set(wx, 0.34, wz);
        const tire = new THREE.Mesh(sidewallGeo, dark);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        w.add(tire);
        const cap = new THREE.Mesh(hubGeo, hub);
        cap.rotation.z = Math.PI / 2;
        w.add(cap);
        g.add(w);
        this.wheels.push(w);
        if (front) this.steerWheels.push(w);
      }
    } else if (this.kind === 'moto') {
      const bodyC = MOTO_COLORS[Math.floor(Math.random() * MOTO_COLORS.length)] as number;
      const body = this.mat(bodyC);
      const dark = this.mat(0x222222);
      const chrome = this.mat(0x9aa2ab);
      const lampF = this.mat(0xfff0b8);
      const add = (geo: THREE.BoxGeometry, m: THREE.MeshStandardMaterial, x: number, y: number, z: number, rx = 0, rz = 0): THREE.Mesh => {
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.set(x, y, z);
        mesh.rotation.x = rx;
        mesh.rotation.z = rz;
        mesh.castShadow = true;
        g.add(mesh);
        return mesh;
      };
      // 车架/油箱/座垫/车把
      add(new THREE.BoxGeometry(0.16, 0.2, 1.3), body, 0, 0.62, 0.1, -0.12);
      add(new THREE.BoxGeometry(0.28, 0.22, 0.45), body, 0, 0.72, 0.35);
      add(new THREE.BoxGeometry(0.26, 0.1, 0.55), dark, 0, 0.72, -0.3);
      add(new THREE.BoxGeometry(0.55, 0.06, 0.08), dark, 0, 0.95, 0.82);
      add(new THREE.BoxGeometry(0.07, 0.4, 0.07), dark, -0.2, 0.78, 0.8);
      add(new THREE.BoxGeometry(0.07, 0.4, 0.07), dark, 0.2, 0.78, 0.8);
      // 挡泥板(前后) + 大灯 + 排气管 + 握把胶 + 边撑
      add(new THREE.BoxGeometry(0.2, 0.05, 0.5), body, 0, 0.74, 0.85, 0.15);
      add(new THREE.BoxGeometry(0.2, 0.05, 0.45), body, 0, 0.7, -0.72, -0.2);
      add(new THREE.BoxGeometry(0.14, 0.12, 0.1), lampF, 0, 0.88, 0.92);
      const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.75, 8), chrome);
      exhaust.rotation.x = Math.PI / 2 - 0.06;
      exhaust.position.set(-0.14, 0.4, -0.3);
      exhaust.castShadow = true;
      g.add(exhaust);
      add(new THREE.BoxGeometry(0.09, 0.07, 0.14), dark, -0.31, 0.95, 0.82);
      add(new THREE.BoxGeometry(0.09, 0.07, 0.14), dark, 0.31, 0.95, 0.82);
      add(new THREE.BoxGeometry(0.04, 0.34, 0.05), dark, -0.16, 0.22, -0.15, 0, 0.35);
      // 轮: 轮胎 + 轮毂盖
      const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.14, 10);
      const hubGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.15, 8);
      for (const [wz, front] of [[0.85, 1], [-0.7, 0]] as const) {
        const w = new THREE.Group();
        w.position.set(0, 0.33, wz);
        const tire = new THREE.Mesh(wheelGeo, dark);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        w.add(tire);
        const cap = new THREE.Mesh(hubGeo, chrome);
        cap.rotation.z = Math.PI / 2;
        w.add(cap);
        g.add(w);
        this.wheels.push(w);
        if (front) this.steerWheels.push(w);
      }
    } else {
      const body = this.mat(0xb48a3d);
      const dark = this.mat(0x26292a);
      const frame = this.mat(0x4d5556);
      const hub = this.mat(0x9ca2a2);
      const add = (geo: THREE.BoxGeometry, mat: THREE.MeshStandardMaterial, x: number, y: number, z: number, rx = 0, rz = 0): THREE.Mesh => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx, 0, rz);
        mesh.castShadow = true;
        g.add(mesh);
        return mesh;
      };
      // 轻型裸露底盘、前鼻和双座舱。
      add(new THREE.BoxGeometry(1.35, 0.26, 2.45), body, 0, 0.48, 0);
      add(new THREE.BoxGeometry(1.08, 0.36, 0.78), body, 0, 0.72, 0.88, -0.12);
      add(new THREE.BoxGeometry(0.42, 0.4, 0.48), dark, -0.28, 0.8, -0.14);
      add(new THREE.BoxGeometry(0.42, 0.4, 0.48), dark, 0.28, 0.8, -0.14);
      // 防滚架和尾部发动机护框。
      for (const sx of [-0.58, 0.58]) {
        add(new THREE.BoxGeometry(0.08, 1.0, 0.08), frame, sx, 1.08, -0.35, 0, sx * 0.14);
        add(new THREE.BoxGeometry(0.08, 0.75, 0.08), frame, sx, 0.93, 0.55, 0, -sx * 0.1);
      }
      add(new THREE.BoxGeometry(1.2, 0.08, 0.08), frame, 0, 1.55, -0.35);
      add(new THREE.BoxGeometry(1.15, 0.5, 0.58), frame, 0, 0.69, -0.95);
      add(new THREE.BoxGeometry(1.55, 0.1, 0.1), dark, 0, 0.35, 1.32);
      add(new THREE.BoxGeometry(1.55, 0.1, 0.1), dark, 0, 0.35, -1.32);
      const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.24, 10);
      const hubGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.27, 8);
      for (const [wx, wz, front] of [[-0.72, 0.92, 1], [0.72, 0.92, 1], [-0.72, -0.92, 0], [0.72, -0.92, 0]] as const) {
        const wheel = new THREE.Group();
        wheel.position.set(wx, 0.38, wz);
        const tire = new THREE.Mesh(wheelGeo, dark);
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        wheel.add(tire);
        const cap = new THREE.Mesh(hubGeo, hub);
        cap.rotation.z = Math.PI / 2;
        wheel.add(cap);
        g.add(wheel);
        this.wheels.push(wheel);
        if (front) this.steerWheels.push(wheel);
      }
    }
  }

  private mat(color: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.16 });
    this.mats.push(m);
    return m;
  }

  // 模型位姿同步(位置/朝向/坡度)
  sync(): void {
    this.group.position.copy(this.pos);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }

  // 轮自转与前轮转向(视觉)
  spinWheels(dt: number, steerIn: number): void {
    const r = 0.34;
    for (const w of this.wheels) w.rotation.x += (this.speed / r) * dt;
    for (const w of this.steerWheels) w.rotation.y = steerIn * 0.42;
  }

  // 烧毁变暗
  darken(): void {
    for (const m of this.mats) m.color.setHex(0x1c1c1c);
  }
}

export class VehicleManager {
  readonly list: Vehicle[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  // 全量重生(对局开始/重开)
  populate(world: World): void {
    for (const v of this.list) this.scene.remove(v.group);
    this.list.length = 0;
    for (const s of VEHICLE_SPAWNS) {
      const spec = VEHICLE_SPEC[s.kind];
      let x = s.x;
      let z = s.z;
      for (let attempt = 0; attempt < 24; attempt++) {
        const ring = attempt === 0 ? 0 : 2.5 + Math.floor((attempt - 1) / 8) * 2.5;
        const angle = attempt * 2.399963;
        const candidateX = s.x + Math.cos(angle) * ring;
        const candidateZ = s.z + Math.sin(angle) * ring;
        if (world.inPlot(candidateX, candidateZ, 0.8) ||
          !world.pointFree(candidateX, candidateZ, spec.radius + 0.2, WATER_Y + 0.2, 18)) continue;
        x = candidateX;
        z = candidateZ;
        break;
      }
      const y = world.groundHeight(x, z, 30);
      const v = new Vehicle(s.kind, new THREE.Vector3(x, y, z), s.yaw);
      this.list.push(v);
      this.scene.add(v.group);
    }
  }

  nearest(x: number, z: number, maxD: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = maxD * maxD;
    for (const v of this.list) {
      if (v.dead || v.burnT >= 0 || v.driver) continue;
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = v;
      }
    }
    return best;
  }

  nearestClaimable(x: number, z: number, maxD: number, claimant: Character): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = maxD * maxD;
    for (const v of this.list) {
      if (v.dead || v.burnT >= 0 || v.driver ||
        (v.claimedBy && v.claimedBy !== claimant && v.claimedBy.alive)) continue;
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bestD) continue;
      bestD = d2;
      best = v;
    }
    return best;
  }

  // 射线 vs 载具 OBB(最近命中), 返回载具与 t
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number): { v: Vehicle; t: number } | null {
    let best: { v: Vehicle; t: number } | null = null;
    let bestT = maxT;
    for (const v of this.list) {
      const half = VEHICLE_SPEC[v.kind].half;
      const cy = v.pos.y + 0.72;
      const cosY = Math.cos(v.yaw);
      const sinY = Math.sin(v.yaw);
      const lox0 = o.x - v.pos.x;
      const loz0 = o.z - v.pos.z;
      const lox = lox0 * cosY - loz0 * sinY;
      const loz = lox0 * sinY + loz0 * cosY;
      const ldx = d.x * cosY - d.z * sinY;
      const ldz = d.x * sinY + d.z * cosY;
      const loy = o.y - cy;
      let tmin = 0;
      let tmax = bestT;
      let ok = true;
      // x
      if (Math.abs(ldx) < 1e-9) {
        if (lox < -half[0] || lox > half[0]) ok = false;
      } else {
        let t1 = (-half[0] - lox) / ldx;
        let t2 = (half[0] - lox) / ldx;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }
      // y
      if (ok) {
        if (Math.abs(d.y) < 1e-9) {
          if (loy < -0.72 || loy > half[1]) ok = false;
        } else {
          let t1 = (-0.72 - loy) / d.y;
          let t2 = (half[1] - loy) / d.y;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) ok = false;
        }
      }
      // z
      if (ok) {
        if (Math.abs(ldz) < 1e-9) {
          if (loz < -half[2] || loz > half[2]) ok = false;
        } else {
          let t1 = (-half[2] - loz) / ldz;
          let t2 = (half[2] - loz) / ldz;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) ok = false;
        }
      }
      if (ok && tmin > 0 && tmin < bestT) {
        bestT = tmin;
        best = { v, t: tmin };
      }
    }
    return best;
  }

  // 掉血: 归零点燃计时, 2s 后爆炸
  damage(v: Vehicle, dmg: number): void {
    if (v.dead) return;
    v.hp -= dmg;
    if (v.hp <= 0) {
      v.hp = 0;
      if (v.burnT < 0) v.burnT = 2;
    }
  }

  // 爆炸: 半径伤害 + 残骸变暗 + 静态碰撞 + 强制下车
  private explode(v: Vehicle, game: Game): void {
    v.exploded = true;
    v.dead = true;
    v.speed = 0;
    game.effects.explosion(v.pos);
    game.soundAt(v.pos, (d, p) => game.audio.explosion(d, p));
    game.addShakeFrom(v.pos);
    for (const c of game.chars) {
      if (!c.alive) continue;
      const d = Math.hypot(c.pos.x - v.pos.x, c.pos.y + 0.9 - v.pos.y, c.pos.z - v.pos.z);
      if (d > 8) continue;
      game.damageChar(c, 100 - 85 * (d / 8), false, v.driver, '载具爆炸', true);
    }
    v.darken();
    // 残骸成为静态障碍
    game.world.addCollider({ kind: 'cyl', x: v.pos.x, z: v.pos.z, r: VEHICLE_SPEC[v.kind].radius * 0.9, y0: v.pos.y - 1, y1: v.pos.y + 1.4, tag: 'rock' });
    if (v.driver) game.forceExitVehicle(v.driver, 55);
  }

  // 涉水熄火: 死火变暗 + 强制下车
  stall(v: Vehicle, game: Game): void {
    if (v.dead) return;
    v.dead = true;
    v.speed = 0;
    v.darken();
    game.world.addCollider({ kind: 'cyl', x: v.pos.x, z: v.pos.z, r: VEHICLE_SPEC[v.kind].radius * 0.9, y0: v.pos.y - 1, y1: v.pos.y + 1.4, tag: 'rock' });
    if (v.driver?.isPlayer) game.hud.toast('车辆进水熄火');
    if (v.driver) game.forceExitVehicle(v.driver, 0);
  }

  update(dt: number, game: Game): void {
    for (const v of this.list) {
      // 燃烧→爆炸
      if (v.burnT > 0) {
        v.burnT -= dt;
        v.fireT -= dt;
        if (v.fireT <= 0) {
          v.fireT = 0.22;
          game.effects.burst(v.pos, 7, 1.0, 0.62, 0.2, 4.2);
          game.effects.burst(v.pos, 4, 0.3, 0.3, 0.32, 2.4);
        }
        if (v.burnT <= 0) {
          v.burnT = -1;
          this.explode(v, game);
        }
      }
      v.sync();
    }
  }
}
