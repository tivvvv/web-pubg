// ─────────────────────────────────────────────────────────────────────────────
// weaponmodels.ts - 程序化低多边形武器模型(three.js 基本体拼装, 共享几何/材质)
// 约定: 原点 = 握把顶端(右手持握点), 枪管朝 +Z, 上为 +Y; 步枪全长约 0.9m
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { ThrowableId, WeaponId } from './types';

export type WeaponModelId = WeaponId | 'knife' | ThrowableId;

export interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D; // 枪口尖端(曳光/火光起点)
  mag: THREE.Object3D | null; // 弹匣部件(换弹动画隐藏/重现)
}

// 枪口火光缩放(狙击更大, 手枪更小, 霰弹最大)
export const MUZZLE_SCALE: Record<WeaponId, number> = {
  pistol: 0.65, smg: 0.85, rifle: 1.0, sniper: 1.5, shotgun: 1.35,
};

// 共享几何: 单位盒 / 单位圆柱(沿 Y, 半径 1 高 1) / 单位球
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
const SPH = new THREE.SphereGeometry(1, 12, 10);

// 共享材质: 深金属 / 亮金属 / 聚合物 / 木色家具
const MAT_DK = new THREE.MeshLambertMaterial({ color: 0x2b2e33 }); // 深金属(机匣/枪管)
const MAT_LT = new THREE.MeshLambertMaterial({ color: 0xb9c1c9 }); // 亮金属(刃口/导轨/枪口)
const MAT_PO = new THREE.MeshLambertMaterial({ color: 0x3d4148 }); // 聚合物(护木/枪托/握把)
const MAT_TN = new THREE.MeshLambertMaterial({ color: 0x9a7a52 }); // 木色/沙色家具
const MAT_FG = new THREE.MeshLambertMaterial({ color: 0x39543a }); // 手雷墨绿
const MAT_BD = new THREE.MeshLambertMaterial({ color: 0xc8503c }); // 烟雾弹色带

function b(
  parent: THREE.Group, mat: THREE.Material,
  sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// 沿 Z 轴的圆柱(枪管/瞄准镜管)
function cz(parent: THREE.Group, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.scale.set(r, len, r);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// 沿 X 轴的圆柱(栓柄)
function cx(parent: THREE.Group, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.scale.set(r, len, r);
  m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function muzzleAt(g: THREE.Group, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = 'muzzle';
  o.position.set(x, y, z);
  g.add(o);
  return o;
}

// ── M416 突击步枪 (~0.9m): 机匣/导轨护木/枪管+制退器/弯弹匣/伸缩托/前后瞄 ──
function buildRifle(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.075, 0.3, 0, 0.02, 0.1);            // 机匣
  b(g, MAT_DK, 0.05, 0.015, 0.3, 0, 0.065, 0.1);            // 上机匣
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.02);        // 导轨 ×3
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.1);
  b(g, MAT_LT, 0.052, 0.006, 0.035, 0, 0.075, 0.18);
  b(g, MAT_PO, 0.05, 0.06, 0.22, 0, 0.02, 0.36);            // 护木
  b(g, MAT_LT, 0.052, 0.005, 0.04, 0, 0.052, 0.3);          // 护木导轨 ×2
  b(g, MAT_LT, 0.052, 0.005, 0.04, 0, 0.052, 0.42);
  cz(g, MAT_DK, 0.011, 0.2, 0, 0.025, 0.55);                // 枪管
  cz(g, MAT_LT, 0.017, 0.06, 0, 0.025, 0.665);              // 制退器
  b(g, MAT_DK, 0.019, 0.014, 0.004, 0.012, 0.025, 0.671);   // 制退器散热孔 ×2
  b(g, MAT_DK, 0.019, 0.014, 0.004, -0.012, 0.025, 0.655);
  b(g, MAT_PO, 0.024, 0.06, 0.03, 0, -0.02, 0.34);          // 前握把
  const mag = b(g, MAT_TN, 0.032, 0.1, 0.055, 0, -0.075, 0.065, 0.25); // 弯弹匣上段
  mag.name = 'mag';
  b(g, MAT_TN, 0.03, 0.08, 0.05, 0, -0.145, 0.042, 0.45);   // 弯弹匣下段
  b(g, MAT_DK, 0.03, 0.03, 0.14, 0, 0.035, -0.14);          // 托芯
  b(g, MAT_PO, 0.042, 0.085, 0.05, 0, 0.01, -0.235);        // 伸缩枪托
  b(g, MAT_DK, 0.045, 0.09, 0.012, 0, 0.008, -0.263);       // 托底板
  b(g, MAT_PO, 0.032, 0.085, 0.045, 0, -0.055, -0.015, 0.3); // 握把
  b(g, MAT_LT, 0.008, 0.03, 0.008, 0, 0.072, 0.46);         // 前准星
  b(g, MAT_DK, 0.03, 0.02, 0.02, 0, 0.077, -0.04);          // 后照门
  // ---- 小零件: 拉机柄/抛壳窗/弹匣释放/扳机+护圈/快慢机 ----
  b(g, MAT_LT, 0.014, 0.012, 0.05, 0, 0.078, -0.07);        // 拉机柄
  b(g, MAT_LT, 0.004, 0.022, 0.07, 0.0285, 0.03, 0.1);      // 抛壳窗
  b(g, MAT_LT, 0.006, 0.014, 0.02, 0.0285, -0.028, 0.045);  // 弹匣释放钮
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.045, 0.028);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.07, 0, -0.062, 0.02);        // 扳机护圈底
  b(g, MAT_LT, 0.004, 0.02, 0.012, -0.0285, 0.005, -0.02);  // 快慢机拨杆
  return { group: g, muzzle: muzzleAt(g, 0, 0.025, 0.7), mag };
}

// ── UMP 冲锋枪 (~0.62m): 方机匣/短枪管/直弹匣/侧折叠托, 明显短于步枪 ──
function buildSmg(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.095, 0.26, 0, 0.02, 0.06);          // 方机匣
  b(g, MAT_DK, 0.045, 0.012, 0.24, 0, 0.075, 0.05);         // 顶导轨
  cz(g, MAT_DK, 0.012, 0.1, 0, 0.03, 0.225);                // 短枪管
  cz(g, MAT_LT, 0.016, 0.03, 0, 0.03, 0.28);                // 枪口帽
  const mag = b(g, MAT_PO, 0.028, 0.15, 0.042, 0, -0.1, 0.04); // 直弹匣
  mag.name = 'mag';
  b(g, MAT_LT, 0.012, 0.015, 0.16, 0.032, 0.05, -0.1);      // 折叠托上杆
  b(g, MAT_LT, 0.012, 0.015, 0.16, 0.032, 0.02, -0.1);      // 折叠托下杆
  b(g, MAT_PO, 0.02, 0.06, 0.03, 0.032, 0.035, -0.19);      // 托垫
  b(g, MAT_PO, 0.032, 0.08, 0.045, 0, -0.05, -0.03, 0.25);  // 握把
  b(g, MAT_LT, 0.008, 0.02, 0.008, 0, 0.086, 0.16);         // 前瞄
  b(g, MAT_DK, 0.025, 0.015, 0.015, 0, 0.086, -0.05);       // 后瞄
  // ---- 小零件: 拉机柄/抛壳窗/扳机+护圈 ----
  b(g, MAT_LT, 0.012, 0.014, 0.04, 0.024, 0.062, -0.02);    // 侧拉机柄
  b(g, MAT_LT, 0.004, 0.02, 0.055, 0.0285, 0.035, 0.06);    // 抛壳窗
  b(g, MAT_DK, 0.006, 0.024, 0.008, 0, -0.042, 0.005);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.06, 0, -0.058, -0.005);      // 扳机护圈底
  return { group: g, muzzle: muzzleAt(g, 0, 0.03, 0.3), mag };
}

// ── AWM 狙击枪 (~1.2m): 长凹槽枪管/顶部大镜管/栓柄/拇指孔枪托/折叠两脚架 ──
function buildSniper(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.055, 0.085, 0.24, 0, 0.02, 0.06);          // 机匣
  cz(g, MAT_DK, 0.013, 0.52, 0, 0.03, 0.44);                // 长枪管
  cz(g, MAT_LT, 0.017, 0.025, 0, 0.03, 0.3);                // 凹槽节套 ×2
  cz(g, MAT_LT, 0.017, 0.025, 0, 0.03, 0.55);
  b(g, MAT_LT, 0.03, 0.035, 0.07, 0, 0.03, 0.72);           // 制退器
  cz(g, MAT_DK, 0.024, 0.2, 0, 0.105, 0.06);                // 瞄准镜管
  cz(g, MAT_DK, 0.032, 0.05, 0, 0.105, 0.175);              // 物镜钟
  cz(g, MAT_DK, 0.03, 0.045, 0, 0.105, -0.055);             // 目镜钟
  b(g, MAT_LT, 0.012, 0.026, 0.03, 0, 0.076, 0.1);          // 镜架 ×2
  b(g, MAT_LT, 0.012, 0.026, 0.03, 0, 0.076, -0.01);
  cx(g, MAT_LT, 0.008, 0.06, 0.05, 0.03, 0);                // 栓柄
  b(g, MAT_LT, 0.02, 0.02, 0.02, 0.082, 0.03, 0);           // 栓球
  // 瞄准镜调节旋钮(高低/风偏) + 贴腮板
  cx(g, MAT_LT, 0.014, 0.02, 0, 0.135, 0.06);               // 高低旋钮
  cx(g, MAT_LT, 0.012, 0.02, 0.028, 0.105, 0.06);           // 风偏旋钮
  b(g, MAT_PO, 0.04, 0.02, 0.09, 0, 0.075, -0.2);           // 贴腮板
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.048, -0.01);      // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.07, 0, -0.065, -0.02);       // 扳机护圈底
  b(g, MAT_TN, 0.045, 0.035, 0.2, 0, 0.045, -0.22);         // 枪托上板
  b(g, MAT_TN, 0.045, 0.045, 0.2, 0, -0.035, -0.22);        // 枪托下板(中间镂空=拇指孔)
  b(g, MAT_PO, 0.048, 0.11, 0.025, 0, 0.005, -0.325);       // 托底板
  b(g, MAT_DK, 0.008, 0.012, 0.16, 0.02, -0.005, 0.5, 0.08); // 折叠两脚架(贴枪管)
  b(g, MAT_DK, 0.008, 0.012, 0.16, -0.02, -0.005, 0.5, 0.08);
  const mag = b(g, MAT_DK, 0.035, 0.07, 0.09, 0, -0.045, 0.09);
  mag.name = 'mag';
  b(g, MAT_PO, 0.032, 0.07, 0.045, 0, -0.05, -0.06, 0.3);   // 握把
  return { group: g, muzzle: muzzleAt(g, 0, 0.03, 0.76), mag };
}

// ── P92 手枪 (~0.23m): 套筒+防滑纹/底把/握把/扳机护圈/小瞄具 ──
function buildPistol(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_DK, 0.04, 0.045, 0.2, 0, 0.035, 0.02);           // 套筒
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, -0.03);       // 防滑纹 ×3
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, -0.015);
  b(g, MAT_LT, 0.042, 0.006, 0.008, 0, 0.045, 0);
  b(g, MAT_PO, 0.036, 0.035, 0.17, 0, 0.005, 0.01);         // 底把
  b(g, MAT_TN, 0.036, 0.085, 0.048, 0, -0.05, -0.035, 0.22); // 握把
  b(g, MAT_LT, 0.008, 0.008, 0.055, 0, -0.022, 0.045);      // 扳机护圈
  b(g, MAT_LT, 0.008, 0.02, 0.008, 0, -0.012, 0.02);
  b(g, MAT_LT, 0.006, 0.012, 0.006, 0, 0.063, 0.1);         // 前瞄
  b(g, MAT_DK, 0.02, 0.01, 0.012, 0, 0.063, -0.065);        // 后瞄
  b(g, MAT_LT, 0.004, 0.008, 0.028, 0.021, 0.045, -0.045);  // 空仓挂机杆
  b(g, MAT_LT, 0.006, 0.014, 0.018, 0.02, 0.0, -0.03);      // 弹匣释放钮
  b(g, MAT_DK, 0.016, 0.022, 0.012, 0, 0.035, -0.095);      // 击锤
  b(g, MAT_DK, 0.006, 0.02, 0.008, 0, -0.018, 0.02);        // 扳机
  cz(g, MAT_DK, 0.011, 0.025, 0, 0.032, 0.115);             // 枪口
  const mag = b(g, MAT_LT, 0.034, 0.012, 0.05, 0, -0.096, -0.048, 0.22); // 弹匣底板
  mag.name = 'mag';
  return { group: g, muzzle: muzzleAt(g, 0, 0.032, 0.13), mag };
}

// ── 砍刀 (~0.55m): 宽刃微弯刀身/亮刃口/护手/缠绳柄 ──
function buildKnife(): WeaponModel {
  const g = new THREE.Group();
  b(g, MAT_LT, 0.004, 0.075, 0.3, 0, 0, 0.2);               // 刀身
  b(g, MAT_LT, 0.004, 0.06, 0.14, 0, 0.014, 0.375, -0.1);   // 微弯刀尖
  b(g, MAT_DK, 0.005, 0.02, 0.44, 0, 0.03, 0.22);           // 深色刀背(衬出亮刃)
  b(g, MAT_DK, 0.09, 0.02, 0.03, 0, 0, -0.02);              // 护手
  cz(g, MAT_PO, 0.017, 0.13, 0, 0, -0.095);                 // 缠绳柄
  b(g, MAT_TN, 0.04, 0.04, 0.012, 0, 0, -0.06);             // 缠绳结 ×2
  b(g, MAT_TN, 0.04, 0.04, 0.012, 0, 0, -0.13);
  return { group: g, muzzle: muzzleAt(g, 0, 0, 0.45), mag: null };
}

// ── 手雷: 墨绿球体 + 银色压柄 + 顶部引信 ──
function buildFrag(): WeaponModel {
  const g = new THREE.Group();
  const body = new THREE.Mesh(SPH, MAT_FG);
  body.scale.set(0.05, 0.055, 0.05);
  body.castShadow = true;
  g.add(body);
  cz(g, MAT_DK, 0.015, 0.03, 0, 0.06, 0);                 // 引信座
  b(g, MAT_LT, 0.012, 0.02, 0.075, 0.045, 0.045, 0, 0.45); // 压柄
  cx(g, MAT_LT, 0.012, 0.035, -0.025, 0.07, 0);           // 拉环柄
  return { group: g, muzzle: muzzleAt(g, 0, 0.1, 0), mag: null };
}

// ── 烟雾弹: 浅灰罐体 + 红色识别带 + 顶盖 ──
function buildSmoke(): WeaponModel {
  const g = new THREE.Group();
  cz(g, MAT_LT, 0.045, 0.12, 0, 0, 0);        // 罐体
  cz(g, MAT_BD, 0.047, 0.03, 0, 0.02, 0);     // 色带
  cz(g, MAT_DK, 0.02, 0.02, 0, 0.07, 0);      // 顶盖
  cx(g, MAT_DK, 0.01, 0.03, -0.02, 0.075, 0); // 保险销
  return { group: g, muzzle: muzzleAt(g, 0, 0.1, 0), mag: null };
}

// ── S686 双管霰弹枪 (~0.75m): 并排双管/木制枪托+护木/中折铰链/珠形准星 ──
function buildShotgun(): WeaponModel {
  const g = new THREE.Group();
  // 机匣(铰链块) + 顶部锁扣
  b(g, MAT_DK, 0.06, 0.075, 0.16, 0, 0.02, -0.02);
  b(g, MAT_LT, 0.02, 0.02, 0.05, 0, 0.068, -0.06);           // 开锁拨杆
  // 并排双管(左右各一) + 上下层板
  cz(g, MAT_DK, 0.013, 0.52, -0.018, 0.035, 0.32);
  cz(g, MAT_DK, 0.013, 0.52, 0.018, 0.035, 0.32);
  b(g, MAT_DK, 0.05, 0.008, 0.52, 0, 0.048, 0.32);           // 管间上肋条
  // 木制护木(前段包裹双管) + 木纹深色下托
  b(g, MAT_TN, 0.058, 0.055, 0.24, 0, 0.012, 0.3);
  b(g, MAT_DK, 0.008, 0.02, 0.5, 0, -0.012, 0.32);           // 管下衬
  // 中折铰链暗示(管尾与机匣之间的亮环)
  cz(g, MAT_LT, 0.021, 0.02, -0.018, 0.035, 0.06);
  cz(g, MAT_LT, 0.021, 0.02, 0.018, 0.035, 0.06);
  // 珠形准星
  b(g, MAT_LT, 0.007, 0.014, 0.007, 0, 0.062, 0.56);
  // 木制枪托(后收细) + 托底板
  b(g, MAT_TN, 0.052, 0.075, 0.24, 0, 0.005, -0.22);
  b(g, MAT_TN, 0.045, 0.09, 0.06, 0, -0.01, -0.36);
  b(g, MAT_DK, 0.047, 0.1, 0.014, 0, -0.01, -0.395);         // 托底板
  b(g, MAT_DK, 0.006, 0.026, 0.008, 0, -0.042, 0.01);        // 扳机
  b(g, MAT_DK, 0.008, 0.006, 0.06, 0, -0.058, -0.01);        // 扳机护圈底
  return { group: g, muzzle: muzzleAt(g, 0, 0.035, 0.59), mag: null };
}

// 原型缓存: 每型只建一次, 之后一律 clone(true)(共享几何/材质)
const protos = new Map<WeaponModelId, WeaponModel>();
function proto(id: WeaponModelId): WeaponModel {
  let p = protos.get(id);
  if (!p) {
    switch (id) {
      case 'rifle': p = buildRifle(); break;
      case 'smg': p = buildSmg(); break;
      case 'sniper': p = buildSniper(); break;
      case 'shotgun': p = buildShotgun(); break;
      case 'pistol': p = buildPistol(); break;
      case 'knife': p = buildKnife(); break;
      case 'frag': p = buildFrag(); break;
      case 'smoke': p = buildSmoke(); break;
    }
    protos.set(id, p);
  }
  return p;
}

// 克隆一份可用模型; muzzle/mag 通过命名在克隆体上找回
export function buildWeaponModel(id: WeaponModelId): WeaponModel {
  const p = proto(id);
  const group = p.group.clone(true);
  const muzzle = group.getObjectByName('muzzle') as THREE.Object3D;
  const mag = (group.getObjectByName('mag') as THREE.Object3D | undefined) ?? null;
  return { group, muzzle, mag };
}
