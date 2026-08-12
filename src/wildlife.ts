import * as THREE from 'three';
import { applySurfaceAsset } from './assets';
import { ROAD_PATHS, WATER_Y, riverZAt, type World } from './world';
import { regionById } from './regions';
import { resolveBodyAgainstVehicle, VEHICLE_SPEC, type Vehicle } from './vehicles';

export type WildlifeKind = 'cow' | 'sheep' | 'fish' | 'bird' | 'tiger';

export interface ForestTreasure {
  readonly group: THREE.Group;
  readonly lid: THREE.Group;
  readonly pos: THREE.Vector3;
  readonly loot: THREE.Group;
  opened: boolean;
  lidT: number;
}

export interface ForestCoreMetrics {
  readonly nearbyTrees: number;
  readonly coveredTreeSectors: number;
  readonly buildingDistance: number;
  readonly roadDistance: number;
  readonly lumberyardDistance: number;
  readonly dryLandSectors: number;
  readonly shorelineClearance: number;
}

export interface WildlifeEntity {
  readonly kind: WildlifeKind;
  readonly group: THREE.Group;
  readonly anchor: THREE.Vector3;
  readonly spawn: THREE.Vector3;
  readonly limbs: THREE.Object3D[];
  readonly radius: number;
  readonly centerY: number;
  readonly maxHp: number;
  hp: number;
  alive: boolean;
  heading: number;
  speed: number;
  phase: number;
  decisionTimer: number;
  deathVy: number;
  attackCooldown: number;
  attackPose: number;
}

export interface WildlifeHit {
  entity: WildlifeEntity;
  t: number;
  point: THREE.Vector3;
}

export interface WildlifeMeleeTarget {
  readonly entity: WildlifeEntity;
  readonly distance: number;
}

export interface WildlifeCharacterBody {
  readonly alive: boolean;
  readonly swimming: boolean;
  readonly radius: number;
  readonly pos: THREE.Vector3;
}

export type TigerAttackHandler = (target: WildlifeCharacterBody, damage: number, tiger: WildlifeEntity) => void;

export const WILDLIFE_COUNTS: Readonly<Record<WildlifeKind, number>> = Object.freeze({
  cow: 5,
  sheep: 8,
  fish: 14,
  bird: 12,
  tiger: 3,
});

const MAT = {
  cow: new THREE.MeshStandardMaterial({ color: 0x6a4430, roughness: 0.92 }),
  cowDark: new THREE.MeshStandardMaterial({ color: 0x29201b, roughness: 0.95 }),
  cowLight: new THREE.MeshStandardMaterial({ color: 0xe0d2b5, roughness: 0.94 }),
  muzzle: new THREE.MeshStandardMaterial({ color: 0xb98d72, roughness: 0.9 }),
  horn: new THREE.MeshStandardMaterial({ color: 0xd8c9a0, roughness: 0.8 }),
  hoof: new THREE.MeshStandardMaterial({ color: 0x26211d, roughness: 0.98 }),
  animalEye: new THREE.MeshStandardMaterial({ color: 0x151310, roughness: 0.45, metalness: 0.08 }),
  wool: new THREE.MeshStandardMaterial({ color: 0xd8d4c4, roughness: 1 }),
  woolShade: new THREE.MeshStandardMaterial({ color: 0xbcb9ad, roughness: 1 }),
  sheepDark: new THREE.MeshStandardMaterial({ color: 0x38352f, roughness: 0.96 }),
  fishA: new THREE.MeshStandardMaterial({ color: 0xf0b248, roughness: 0.46, metalness: 0.08 }),
  fishB: new THREE.MeshStandardMaterial({ color: 0x5bd4d0, roughness: 0.42, metalness: 0.12 }),
  fin: new THREE.MeshStandardMaterial({ color: 0x397c83, roughness: 0.58, side: THREE.DoubleSide }),
  bird: new THREE.MeshStandardMaterial({ color: 0x3f4648, roughness: 0.85, side: THREE.DoubleSide }),
  birdLight: new THREE.MeshStandardMaterial({ color: 0x9b9b8d, roughness: 0.9, side: THREE.DoubleSide }),
  birdDark: new THREE.MeshStandardMaterial({ color: 0x242b30, roughness: 0.88, side: THREE.DoubleSide }),
  birdBreast: new THREE.MeshStandardMaterial({ color: 0xc7bca6, roughness: 0.92, side: THREE.DoubleSide }),
  beak: new THREE.MeshStandardMaterial({ color: 0xd29c3b, roughness: 0.74 }),
  tiger: new THREE.MeshStandardMaterial({ color: 0xd47a24, roughness: 0.88 }),
  tigerLight: new THREE.MeshStandardMaterial({ color: 0xe9c38f, roughness: 0.92 }),
  tigerStripe: new THREE.MeshStandardMaterial({ color: 0x221c18, roughness: 0.96 }),
  tigerEye: new THREE.MeshStandardMaterial({ color: 0xe8c340, emissive: 0x9f7418, emissiveIntensity: 0.6, roughness: 0.42 }),
  chestWood: new THREE.MeshStandardMaterial({ color: 0xb66d24, emissive: 0x5a2507, emissiveIntensity: 0.32, roughness: 0.62 }),
  chestDark: new THREE.MeshStandardMaterial({ color: 0x4a2415, roughness: 0.82 }),
  chestMetal: new THREE.MeshStandardMaterial({ color: 0xffcf43, emissive: 0xc76a08, emissiveIntensity: 1.05, roughness: 0.2, metalness: 0.86 }),
  chestGlow: new THREE.MeshStandardMaterial({ color: 0xffe36d, emissive: 0xffa000, emissiveIntensity: 2.1, roughness: 0.18, metalness: 0.42 }),
  chestGem: new THREE.MeshStandardMaterial({ color: 0x8ff9ff, emissive: 0x25bddd, emissiveIntensity: 1.8, roughness: 0.15, metalness: 0.18 }),
  chestLeafA: new THREE.MeshStandardMaterial({ color: 0x4e6b38, roughness: 0.98 }),
  chestLeafB: new THREE.MeshStandardMaterial({ color: 0x77804a, roughness: 0.98 }),
};
applySurfaceAsset(MAT.tiger, 'fabric', 5.2, 0.22);
applySurfaceAsset(MAT.tigerLight, 'fabric', 5.8, 0.18);
applySurfaceAsset(MAT.cow, 'fabric', 4.8, 0.3);
applySurfaceAsset(MAT.cowDark, 'fabric', 5.2, 0.26);
applySurfaceAsset(MAT.wool, 'fabric', 6.4, 0.24);
applySurfaceAsset(MAT.woolShade, 'fabric', 6.8, 0.22);
applySurfaceAsset(MAT.chestWood, 'wood', 3.4, 0.78);
applySurfaceAsset(MAT.chestDark, 'wood', 4.6, 0.68);
applySurfaceAsset(MAT.chestMetal, 'metal', 5.8, 0.72);
applySurfaceAsset(MAT.chestLeafA, 'foliage', 5.2, 0.62);
applySurfaceAsset(MAT.chestLeafB, 'foliage', 5.8, 0.56);

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number, y: number, z: number,
  sx = 1, sy = 1, sz = 1,
): THREE.Mesh {
  const part = new THREE.Mesh(geometry, material);
  part.position.set(x, y, z);
  part.scale.set(sx, sy, sz);
  part.castShadow = true;
  part.receiveShadow = true;
  return part;
}

function buildCow(variant: number): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.name = 'wildlife-cow';
  const bodyMat = variant % 2 === 0 ? MAT.cow : MAT.cowDark;
  const body = mesh(new THREE.SphereGeometry(0.58, 16, 10), bodyMat, 0, 0.94, -0.03, 1.42, 0.88, 1.2);
  body.name = 'cow-body';
  group.add(body);
  const shoulder = mesh(new THREE.SphereGeometry(0.43, 14, 9), bodyMat, 0, 1.02, 0.54, 1.16, 1.04, 0.98);
  shoulder.name = 'cow-shoulder';
  group.add(shoulder);
  const neck = mesh(new THREE.SphereGeometry(0.31, 12, 8), bodyMat, 0, 1.16, 0.78, 0.92, 1.15, 0.86);
  neck.name = 'cow-neck';
  group.add(neck);
  const head = mesh(new THREE.DodecahedronGeometry(0.36, 2), bodyMat, 0, 1.25, 1.02, 0.92, 0.88, 1.02);
  head.name = 'cow-head';
  group.add(head);
  const muzzle = mesh(new THREE.BoxGeometry(0.46, 0.24, 0.34), MAT.muzzle, 0, 1.1, 1.3);
  muzzle.name = 'cow-muzzle';
  group.add(muzzle);
  const blaze = mesh(new THREE.BoxGeometry(0.17, 0.3, 0.025), MAT.cowLight, 0, 1.34, 1.325);
  blaze.name = 'cow-face-blaze';
  group.add(blaze);
  // 贴近身体侧面的斑块使用压扁椭球，避免旧版悬浮小球的玩具感。
  for (const [x, y, z, sx, sy] of [[-0.57, 1.06, -0.25, 0.42, 0.34], [0.57, 0.83, 0.15, 0.34, 0.28]] as const) {
    const patch = mesh(new THREE.SphereGeometry(0.25, 10, 7), variant % 2 === 0 ? MAT.cowDark : MAT.cowLight, x, y, z, sx, sy, 0.12);
    patch.name = 'cow-coat-patch';
    group.add(patch);
  }
  for (const side of [-1, 1]) {
    const horn = mesh(new THREE.ConeGeometry(0.07, 0.28, 7), MAT.horn, side * 0.25, 1.45, 0.97);
    horn.name = side < 0 ? 'cow-horn-left' : 'cow-horn-right';
    horn.rotation.z = side * 0.72;
    group.add(horn);
    const ear = mesh(new THREE.ConeGeometry(0.11, 0.25, 6), bodyMat, side * 0.34, 1.34, 0.87);
    ear.name = side < 0 ? 'cow-ear-left' : 'cow-ear-right';
    ear.rotation.z = side * 1.25;
    group.add(ear);
    const eye = mesh(new THREE.SphereGeometry(0.043, 8, 6), MAT.animalEye, side * 0.185, 1.31, 1.31);
    eye.name = side < 0 ? 'cow-eye-left' : 'cow-eye-right';
    group.add(eye);
  }
  for (const side of [-1, 1]) {
    const nostril = mesh(new THREE.SphereGeometry(0.025, 7, 5), MAT.cowDark, side * 0.105, 1.13, 1.48, 1, 0.72, 0.5);
    nostril.name = 'cow-nostril';
    group.add(nostril);
  }
  const udder = mesh(new THREE.SphereGeometry(0.2, 10, 7), MAT.muzzle, 0, 0.55, -0.04, 1.2, 0.62, 0.9);
  udder.name = 'cow-udder';
  group.add(udder);
  const limbs: THREE.Object3D[] = [];
  for (const x of [-0.42, 0.42]) for (const z of [-0.42, 0.42]) {
    const leg = new THREE.Group();
    leg.position.set(x, 0.72, z);
    leg.name = 'cow-leg';
    leg.add(mesh(new THREE.BoxGeometry(0.17, 0.42, 0.17), bodyMat, 0, -0.2, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.145, 0.27, 0.145), MAT.cowDark, 0, -0.53, 0));
    const hoof = mesh(new THREE.BoxGeometry(0.18, 0.12, 0.25), MAT.hoof, 0, -0.69, 0.04);
    hoof.name = 'cow-hoof';
    leg.add(hoof);
    group.add(leg);
    limbs.push(leg);
  }
  const tail = new THREE.Group();
  tail.name = 'cow-tail';
  tail.position.set(0, 1.13, -0.82);
  const tailCord = mesh(new THREE.CylinderGeometry(0.03, 0.045, 0.64, 7), bodyMat, 0, -0.28, -0.14);
  tailCord.rotation.x = 0.46;
  tail.add(tailCord);
  const tailTuft = mesh(new THREE.ConeGeometry(0.1, 0.24, 7), MAT.cowDark, 0, -0.6, -0.3);
  tailTuft.name = 'cow-tail-tuft';
  tail.add(tailTuft);
  group.add(tail);
  limbs.push(tail);
  return { group, limbs };
}

function buildSheep(): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.name = 'wildlife-sheep';
  const core = mesh(new THREE.IcosahedronGeometry(0.58, 2), MAT.woolShade, 0, 0.82, -0.04, 1.18, 0.88, 1.02);
  core.name = 'sheep-wool-core';
  group.add(core);
  // 大小与高度错开的毛团形成连续卷毛轮廓，不再只有一个多面球。
  for (const [x, y, z, s, shade] of [
    [-0.4, 0.94, 0.22, 0.42, 0], [0, 1.08, 0.26, 0.45, 1], [0.4, 0.92, 0.2, 0.4, 0],
    [-0.42, 0.96, -0.22, 0.4, 1], [0, 1.13, -0.3, 0.43, 0], [0.4, 0.98, -0.22, 0.39, 1],
    [-0.28, 0.72, -0.38, 0.35, 0], [0.28, 0.73, -0.4, 0.34, 1],
  ] as const) {
    const tuft = mesh(new THREE.IcosahedronGeometry(0.42, 1), shade ? MAT.woolShade : MAT.wool, x, y, z, s / 0.42, s / 0.42, s / 0.42);
    tuft.name = 'sheep-wool-tuft';
    group.add(tuft);
  }
  const head = mesh(new THREE.DodecahedronGeometry(0.29, 2), MAT.sheepDark, 0, 0.99, 0.75, 0.82, 0.95, 1.12);
  head.name = 'sheep-head';
  group.add(head);
  const muzzle = mesh(new THREE.BoxGeometry(0.25, 0.16, 0.2), MAT.muzzle, 0, 0.88, 0.98);
  muzzle.name = 'sheep-muzzle';
  group.add(muzzle);
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.09, 0.2, 6), MAT.sheepDark, side * 0.22, 1.08, 0.67);
    ear.name = side < 0 ? 'sheep-ear-left' : 'sheep-ear-right';
    ear.rotation.z = side * 1.22;
    group.add(ear);
    const eye = mesh(new THREE.SphereGeometry(0.035, 8, 6), MAT.animalEye, side * 0.145, 1.05, 0.99);
    eye.name = side < 0 ? 'sheep-eye-left' : 'sheep-eye-right';
    group.add(eye);
  }
  const limbs: THREE.Object3D[] = [];
  for (const x of [-0.31, 0.31]) for (const z of [-0.3, 0.3]) {
    const leg = new THREE.Group();
    leg.name = 'sheep-leg';
    leg.position.set(x, 0.55, z);
    leg.add(mesh(new THREE.BoxGeometry(0.12, 0.38, 0.12), MAT.sheepDark, 0, -0.18, 0));
    const hoof = mesh(new THREE.BoxGeometry(0.14, 0.1, 0.2), MAT.hoof, 0, -0.42, 0.035);
    hoof.name = 'sheep-hoof';
    leg.add(hoof);
    group.add(leg);
    limbs.push(leg);
  }
  const tail = mesh(new THREE.IcosahedronGeometry(0.18, 1), MAT.wool, 0, 0.92, -0.66, 1, 0.9, 1.15);
  tail.name = 'sheep-tail';
  group.add(tail);
  return { group, limbs };
}

function buildFish(variant: number): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  const material = variant % 2 === 0 ? MAT.fishA : MAT.fishB;
  // 鱼背略高于根节点，让近水面的鱼从岸上也能辨认，同时主体仍在水线以下。
  group.add(mesh(new THREE.SphereGeometry(0.42, 12, 8), material, 0, 0.12, 0, 0.66, 0.34, 1.15));
  const tail = mesh(new THREE.ConeGeometry(0.28, 0.42, 3), MAT.fin, 0, 0.12, -0.62);
  tail.rotation.x = -Math.PI / 2;
  group.add(tail);
  for (const side of [-1, 1]) {
    const fin = mesh(new THREE.ConeGeometry(0.13, 0.3, 3), MAT.fin, side * 0.23, 0.07, 0.02);
    fin.rotation.z = side * 1.1;
    group.add(fin);
  }
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x090d0e });
  for (const side of [-1, 1]) group.add(mesh(new THREE.SphereGeometry(0.035, 7, 5), eyeMat, side * 0.2, 0.2, 0.35));
  return { group, limbs: [tail] };
}

function buildBird(variant: number): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.name = 'wildlife-bird';
  const material = variant % 3 === 0 ? MAT.birdLight : MAT.bird;
  const body = mesh(new THREE.SphereGeometry(0.24, 14, 9), material, 0, 0, 0, 0.84, 0.62, 1.42);
  body.name = 'bird-body';
  group.add(body);
  const breast = mesh(new THREE.SphereGeometry(0.19, 12, 8), MAT.birdBreast, 0, -0.055, 0.18, 0.72, 0.68, 0.9);
  breast.name = 'bird-breast';
  group.add(breast);
  const head = mesh(new THREE.SphereGeometry(0.15, 12, 8), material, 0, 0.08, 0.34);
  head.name = 'bird-head';
  group.add(head);
  const beak = mesh(new THREE.ConeGeometry(0.07, 0.22, 6), MAT.beak, 0, 0.02, 0.51);
  beak.name = 'bird-beak';
  beak.rotation.x = Math.PI / 2;
  group.add(beak);
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.025, 7, 5), MAT.animalEye, side * 0.105, 0.115, 0.455);
    eye.name = side < 0 ? 'bird-eye-left' : 'bird-eye-right';
    group.add(eye);
  }
  const wings: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'bird-wing-left' : 'bird-wing-right';
    pivot.position.x = side * 0.12;
    const wing = mesh(new THREE.SphereGeometry(0.25, 10, 6), material, side * 0.34, 0, -0.08, 1.5, 0.16, 0.78);
    wing.name = 'bird-wing-coverts';
    pivot.add(wing);
    for (let feather = 0; feather < 3; feather++) {
      const primary = mesh(
        new THREE.ConeGeometry(0.08, 0.52 + feather * 0.08, 4),
        feather === 2 ? MAT.birdDark : material,
        side * (0.48 + feather * 0.1),
        -0.015,
        -0.1 - feather * 0.07,
      );
      primary.name = 'bird-primary-feather';
      primary.rotation.z = side * Math.PI / 2;
      primary.rotation.y = side * (0.1 + feather * 0.08);
      pivot.add(primary);
    }
    group.add(pivot);
    wings.push(pivot);
  }
  for (const side of [-1, 0, 1]) {
    const tail = mesh(new THREE.ConeGeometry(0.075, 0.48 - Math.abs(side) * 0.06, 4), side === 0 ? MAT.birdDark : material, side * 0.1, 0, -0.48);
    tail.name = 'bird-tail-feather';
    tail.rotation.x = -Math.PI / 2;
    tail.rotation.z = side * 0.18;
    group.add(tail);
  }
  return { group, limbs: wings };
}

function buildTiger(): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.name = 'forest-guardian-tiger';

  const body = mesh(new THREE.SphereGeometry(0.61, 16, 10), MAT.tiger, 0, 0.96, -0.05, 0.86, 0.78, 1.62);
  group.add(body);
  const shoulder = mesh(new THREE.SphereGeometry(0.5, 14, 9), MAT.tiger, 0, 1.02, 0.47, 0.94, 0.92, 0.82);
  group.add(shoulder);
  const haunch = mesh(new THREE.SphereGeometry(0.49, 14, 9), MAT.tiger, 0, 0.97, -0.61, 0.96, 0.9, 0.86);
  group.add(haunch);
  const chest = mesh(new THREE.SphereGeometry(0.47, 14, 9), MAT.tigerLight, 0, 0.91, 0.56, 0.62, 0.74, 0.54);
  group.add(chest);

  const neck = mesh(new THREE.SphereGeometry(0.4, 14, 9), MAT.tiger, 0, 1.12, 0.72, 0.88, 1.02, 0.9);
  group.add(neck);
  const head = mesh(new THREE.DodecahedronGeometry(0.41, 2), MAT.tiger, 0, 1.24, 1.02, 1.02, 0.92, 1.02);
  group.add(head);
  for (const side of [-1, 1]) {
    group.add(mesh(new THREE.SphereGeometry(0.19, 12, 8), MAT.tigerLight, side * 0.145, 1.12, 1.3, 1, 0.72, 0.82));
  }
  group.add(mesh(new THREE.SphereGeometry(0.16, 12, 8), MAT.tigerLight, 0, 1.02, 1.25, 1.2, 0.56, 0.88));
  const nose = mesh(new THREE.ConeGeometry(0.075, 0.12, 5), MAT.tigerStripe, 0, 1.15, 1.46);
  nose.rotation.x = Math.PI / 2;
  group.add(nose);
  const mouth = mesh(new THREE.BoxGeometry(0.2, 0.025, 0.025), MAT.tigerStripe, 0, 1.03, 1.43);
  mouth.rotation.x = 0.12;
  group.add(mouth);

  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.14, 0.29, 7), MAT.tiger, side * 0.27, 1.58, 0.98);
    ear.rotation.z = side * 0.16;
    group.add(ear);
    const earInner = mesh(new THREE.ConeGeometry(0.075, 0.18, 7), MAT.tigerLight, side * 0.27, 1.58, 1.015);
    earInner.rotation.z = side * 0.16;
    group.add(earInner);
    group.add(mesh(new THREE.SphereGeometry(0.068, 10, 7), MAT.tigerStripe, side * 0.155, 1.3, 1.32));
    group.add(mesh(new THREE.SphereGeometry(0.038, 10, 7), MAT.tigerEye, side * 0.155, 1.305, 1.377));
  }

  // 贴在侧面的三角条纹代替悬浮黑色长条, 近景和远景都保持老虎特征。
  const stripeGeometry = new THREE.CircleGeometry(0.15, 3);
  for (const side of [-1, 1]) {
    for (let index = 0; index < 5; index++) {
      const stripe = mesh(stripeGeometry, MAT.tigerStripe, side * 0.525, 1.08 + (index % 2) * 0.06, -0.66 + index * 0.3);
      stripe.rotation.y = side * Math.PI / 2;
      stripe.rotation.z = side * (index % 2 === 0 ? 0.2 : -0.24);
      stripe.scale.set(0.72 + (index % 3) * 0.08, 1.16, 1);
      group.add(stripe);
    }
  }
  for (const [x, rotation] of [[-0.14, -0.2], [0, 0], [0.14, 0.2]] as const) {
    const browStripe = mesh(new THREE.ConeGeometry(0.042, 0.2, 3), MAT.tigerStripe, x, 1.43, 1.31);
    browStripe.rotation.z = rotation;
    group.add(browStripe);
  }

  const whiskerGeometry = new THREE.BufferGeometry();
  const whiskerPoints: number[] = [];
  for (const side of [-1, 1]) for (const y of [1.08, 1.14]) {
    whiskerPoints.push(side * 0.12, y, 1.42, side * 0.48, y + 0.025, 1.5);
  }
  whiskerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(whiskerPoints, 3));
  const whiskers = new THREE.LineSegments(
    whiskerGeometry,
    new THREE.LineBasicMaterial({ color: 0xe7d5b2, transparent: true, opacity: 0.9 }),
  );
  whiskers.name = 'tiger-whiskers';
  group.add(whiskers);

  const limbs: THREE.Object3D[] = [];
  for (const x of [-0.33, 0.33]) {
    for (const z of [-0.48, 0.48]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(x, 0.75, z);
      const leg = mesh(new THREE.CapsuleGeometry(0.105, 0.34, 6, 9), MAT.tiger, 0, -0.22, 0);
      legPivot.add(leg);
      const ankleBand = mesh(new THREE.TorusGeometry(0.106, 0.018, 5, 10), MAT.tigerStripe, 0, -0.36, 0);
      ankleBand.rotation.x = Math.PI / 2;
      legPivot.add(ankleBand);
      const paw = mesh(new THREE.SphereGeometry(0.15, 10, 7), MAT.tigerLight, 0, -0.49, 0.08, 1.05, 0.58, 1.42);
      legPivot.add(paw);
      for (const clawX of [-0.07, 0, 0.07]) {
        const claw = mesh(new THREE.ConeGeometry(0.018, 0.1, 5), MAT.tigerStripe, clawX, -0.51, 0.23);
        claw.rotation.x = Math.PI / 2;
        legPivot.add(claw);
      }
      group.add(legPivot);
      limbs.push(legPivot);
    }
  }

  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 1.03, -0.82);
  for (let index = 0; index < 5; index++) {
    const segmentMaterial = index === 4 || index === 2 ? MAT.tigerStripe : MAT.tiger;
    const segment = mesh(
      new THREE.CapsuleGeometry(Math.max(0.045, 0.08 - index * 0.007), 0.25, 5, 8),
      segmentMaterial,
      Math.sin(index * 0.4) * 0.08,
      -0.04 + index * 0.09,
      -0.18 - index * 0.22,
    );
    segment.rotation.x = 1.18 + index * 0.08;
    segment.rotation.z = Math.sin(index * 0.7) * 0.2;
    tailPivot.add(segment);
  }
  group.add(tailPivot);
  limbs.push(tailPivot);
  return { group, limbs };
}

function buildForestTreasure(): { group: THREE.Group; lid: THREE.Group; loot: THREE.Group } {
  const group = new THREE.Group();
  group.name = 'forest-treasure-chest';
  const body = mesh(new THREE.BoxGeometry(1.5, 0.68, 0.94, 3, 3, 2), MAT.chestWood, 0, 0.39, 0);
  group.add(body);

  // 分片木板、缝隙和深浅变化让箱体不再是一整块棕色方盒。
  for (let index = 0; index < 4; index++) {
    const plank = mesh(
      new THREE.BoxGeometry(1.27, 0.135, 0.035, 3, 1, 1),
      index % 2 === 0 ? MAT.chestWood : MAT.chestDark,
      0,
      0.17 + index * 0.15,
      0.488,
    );
    plank.name = 'treasure-plank';
    group.add(plank);
  }
  for (const x of [-0.68, 0.68]) {
    group.add(mesh(new THREE.BoxGeometry(0.11, 0.76, 1.02), MAT.chestMetal, x, 0.4, 0));
  }
  group.add(mesh(new THREE.BoxGeometry(1.54, 0.1, 1.02), MAT.chestMetal, 0, 0.08, 0));
  group.add(mesh(new THREE.BoxGeometry(1.54, 0.075, 1.02), MAT.chestMetal, 0, 0.72, 0));
  for (const x of [-0.61, 0.61]) for (const z of [-0.38, 0.38]) {
    group.add(mesh(new THREE.BoxGeometry(0.13, 0.12, 0.13), MAT.chestDark, x, 0.06, z));
  }
  const lock = mesh(new THREE.BoxGeometry(0.25, 0.32, 0.13, 2, 2, 1), MAT.chestMetal, 0, 0.43, 0.56);
  lock.name = 'treasure-lock';
  group.add(lock);
  const keyhole = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.025, 10), MAT.chestDark, 0, 0.42, 0.62);
  keyhole.rotation.x = Math.PI / 2;
  group.add(keyhole);
  for (const x of [-0.68, 0.68]) for (const y of [0.16, 0.64]) {
    group.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), MAT.chestDark, x, y, 0.565));
  }
  for (const x of [-0.4, 0.4]) {
    const hinge = mesh(new THREE.BoxGeometry(0.22, 0.1, 0.08), MAT.chestDark, x, 0.73, -0.5);
    hinge.name = 'treasure-hinge';
    group.add(hinge);
  }

  const lid = new THREE.Group();
  lid.position.set(0, 0.73, -0.48);
  const lidCore = mesh(new THREE.BoxGeometry(1.5, 0.18, 0.96, 3, 1, 2), MAT.chestWood, 0, 0.09, 0.48);
  lid.add(lidCore);
  const lidCrown = mesh(new THREE.CylinderGeometry(0.48, 0.48, 1.5, 16, 2, false, 0, Math.PI), MAT.chestWood, 0, 0.17, 0.48);
  lidCrown.rotation.z = Math.PI / 2;
  lid.add(lidCrown);
  for (const x of [-0.68, 0.68]) {
    lid.add(mesh(new THREE.BoxGeometry(0.1, 0.46, 1.02), MAT.chestMetal, x, 0.17, 0.48));
  }
  const lidTrim = mesh(new THREE.BoxGeometry(1.32, 0.075, 0.08), MAT.chestMetal, 0, 0.24, 0.985);
  lidTrim.name = 'treasure-lid-trim';
  lid.add(lidTrim);
  group.add(lid);

  // 宝箱关闭时也有清晰的稀有物识别度: 蓝宝石锁芯、金色辉光和环绕闪点。
  const lockGem = mesh(new THREE.OctahedronGeometry(0.095, 1), MAT.chestGem, 0, 0.5, 0.665, 0.9, 1.2, 0.45);
  lockGem.name = 'treasure-lock-gem';
  group.add(lockGem);
  for (let index = 0; index < 12; index++) {
    const angle = index / 12 * Math.PI * 2;
    const spark = mesh(
      new THREE.OctahedronGeometry(index % 3 === 0 ? 0.045 : 0.03, 0),
      index % 4 === 0 ? MAT.chestGem : MAT.chestGlow,
      Math.cos(angle) * (0.88 + (index % 2) * 0.12),
      0.34 + (index % 4) * 0.2,
      Math.sin(angle) * (0.62 + (index % 3) * 0.08),
    );
    spark.name = 'treasure-spark';
    spark.userData.baseY = spark.position.y;
    spark.userData.phase = index * 0.71;
    group.add(spark);
  }
  const aura = new THREE.PointLight(0xffb72f, 2.4, 11, 1.7);
  aura.name = 'treasure-aura-light';
  aura.position.set(0, 1.05, 0.1);
  group.add(aura);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 1.16, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffc438,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  halo.name = 'treasure-golden-halo';
  halo.position.y = 0.035;
  halo.rotation.x = -Math.PI / 2;
  group.add(halo);

  const lining = mesh(new THREE.BoxGeometry(1.25, 0.075, 0.7), MAT.chestDark, 0, 0.76, 0);
  lining.name = 'treasure-lining';
  group.add(lining);
  const glow = mesh(new THREE.BoxGeometry(1.08, 0.06, 0.56), MAT.chestGlow, 0, 0.82, 0);
  glow.name = 'forest-treasure-glow';
  glow.visible = false;
  group.add(glow);

  // 开盖瞬间可见折叠的吉利服, 随拾取动画收束至角色身上。
  const loot = new THREE.Group();
  loot.name = 'forest-treasure-loot';
  loot.visible = false;
  loot.position.set(0, 0.88, 0.02);
  loot.add(mesh(new THREE.BoxGeometry(0.72, 0.13, 0.48, 3, 1, 2), MAT.chestGlow, 0, 0, 0));
  for (let index = 0; index < 9; index++) {
    const tuft = mesh(
      new THREE.ConeGeometry(0.055, 0.19, 5),
      index % 2 === 0 ? MAT.chestLeafA : MAT.chestLeafB,
      -0.31 + (index % 5) * 0.15,
      0.1,
      -0.16 + Math.floor(index / 5) * 0.28,
    );
    tuft.rotation.z = ((index % 3) - 1) * 0.3;
    loot.add(tuft);
  }
  group.add(loot);
  return { group, lid, loot };
}

function raySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number {
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const root = Math.sqrt(disc);
  const near = -b - root;
  return near >= 0 ? near : -b + root >= 0 ? -b + root : Infinity;
}

function pointToSegmentDistance(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lengthSq = vx * vx + vz * vz;
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / lengthSq))
    : 0;
  return Math.hypot(x - ax - vx * t, z - az - vz * t);
}

/**
 * 用实际树木包围度和人造设施距离判断林区核心, 而不是误用行政区域圆心.
 * 该指标同时供生成器和回归测试使用, 防止再次把林缘空地当成丛林中心.
 */
export function forestCoreMetrics(world: World, x: number, z: number): ForestCoreMetrics {
  let nearbyTrees = 0;
  let treeSectorMask = 0;
  for (const collider of world.cyls) {
    if (collider.tag !== 'tree') continue;
    const dx = collider.x - x;
    const dz = collider.z - z;
    const distance = Math.hypot(dx, dz);
    if (distance < 3.2 || distance > 30) continue;
    nearbyTrees++;
    const angle = (Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2);
    treeSectorMask |= 1 << Math.floor(angle / (Math.PI * 0.25));
  }

  const buildingDistance = world.buildings.plots.reduce((nearest, plot) => {
    const dx = Math.max(plot.minX - x, 0, x - plot.maxX);
    const dz = Math.max(plot.minZ - z, 0, z - plot.maxZ);
    return Math.min(nearest, Math.hypot(dx, dz));
  }, Number.POSITIVE_INFINITY);

  let roadDistance = Number.POSITIVE_INFINITY;
  for (const path of ROAD_PATHS) {
    for (let index = 0; index < path.length - 1; index++) {
      const a = path[index] as readonly [number, number];
      const b = path[index + 1] as readonly [number, number];
      roadDistance = Math.min(roadDistance, pointToSegmentDistance(x, z, a[0], a[1], b[0], b[1]));
    }
  }

  const lumberyard = world.mapSites.find((site) => site.id === 'mistwood-lumberyard');
  const lumberyardDistance = lumberyard
    ? Math.hypot(x - lumberyard.resolvedX, z - lumberyard.resolvedZ)
    : Number.POSITIVE_INFINITY;
  let dryLandSectors = 0;
  let shorelineClearance = 72;
  for (let sector = 0; sector < 8; sector++) {
    const angle = sector / 8 * Math.PI * 2;
    const px = x + Math.cos(angle) * 22;
    const pz = z + Math.sin(angle) * 22;
    if (world.getHeight(px, pz) > WATER_Y + 1.2) dryLandSectors++;
    for (let radius = 8; radius <= 72; radius += 4) {
      const sampleX = x + Math.cos(angle) * radius;
      const sampleZ = z + Math.sin(angle) * radius;
      if (world.getHeight(sampleX, sampleZ) > WATER_Y + 0.8) continue;
      shorelineClearance = Math.min(shorelineClearance, radius);
      break;
    }
  }
  return {
    nearbyTrees,
    coveredTreeSectors: treeSectorMask.toString(2).replace(/0/g, '').length,
    buildingDistance,
    roadDistance,
    lumberyardDistance,
    dryLandSectors,
    shorelineClearance,
  };
}

export class WildlifeSystem {
  readonly root = new THREE.Group();
  readonly entities: WildlifeEntity[] = [];
  readonly treasure: ForestTreasure;
  private readonly world: World;
  private time = 0;

  constructor(world: World, scene: THREE.Scene) {
    this.world = world;
    this.root.name = 'wildlife';
    scene.add(this.root);
    this.treasure = this.createForestTreasure();
    this.spawnLandAnimals();
    this.spawnTigers();
    this.spawnFish();
    this.spawnBirds();
  }

  private addEntity(
    kind: WildlifeKind,
    built: { group: THREE.Group; limbs: THREE.Object3D[] },
    x: number,
    y: number,
    z: number,
    radius: number,
    centerY: number,
    hp: number,
    heading: number,
  ): void {
    built.group.position.set(x, y, z);
    built.group.rotation.y = heading;
    this.root.add(built.group);
    this.entities.push({
      kind,
      group: built.group,
      anchor: new THREE.Vector3(x, y, z),
      spawn: new THREE.Vector3(x, y, z),
      limbs: built.limbs,
      radius,
      centerY,
      maxHp: hp,
      hp,
      alive: true,
      heading,
      speed: 0,
      phase: this.entities.length * 0.73,
      decisionTimer: 0.8 + (this.entities.length % 5) * 0.47,
      deathVy: 0,
      attackCooldown: 0,
      attackPose: 0,
    });
  }

  private createForestTreasure(): ForestTreasure {
    const forest = regionById('mistwood');
    const deepTrees = this.world.cyls.filter((collider) => {
      // 实际连续林带向雾松林标注区西北侧延伸, 不能再被区域圆形边界截断.
      if (collider.tag !== 'tree' || collider.x > -60 || collider.z > -190) return false;
      const metrics = forestCoreMetrics(this.world, collider.x, collider.z);
      return metrics.nearbyTrees >= 24 && metrics.buildingDistance >= 70 && metrics.roadDistance >= 80 &&
        metrics.lumberyardDistance >= 120 && metrics.dryLandSectors === 8 && metrics.shorelineClearance >= 44;
    });
    // 以真正处在连续密林中的树木质心作为搜索锚点. 这通常位于雾松林西北腹地,
    // 与南侧道路入口和北境木场保持明显距离.
    const coreX = deepTrees.length > 0
      ? deepTrees.reduce((sum, tree) => sum + tree.x, 0) / deepTrees.length
      : forest.x - 144;
    const coreZ = deepTrees.length > 0
      ? deepTrees.reduce((sum, tree) => sum + tree.z, 0) / deepTrees.length
      : forest.z - 25;
    let chosenX = coreX;
    let chosenZ = coreZ;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3200; attempt++) {
      const ring = Math.sqrt(attempt / 3199) * 78;
      const angle = attempt * 2.399963 + 0.42;
      const x = coreX + Math.cos(angle) * ring;
      const z = coreZ + Math.sin(angle) * ring;
      if (x > -60 || z > -190) continue;
      const ground = this.world.getHeight(x, z);
      const slope = Math.max(
        Math.abs(this.world.getHeight(x + 1.4, z) - this.world.getHeight(x - 1.4, z)),
        Math.abs(this.world.getHeight(x, z + 1.4) - this.world.getHeight(x, z - 1.4)),
      ) / 2.8;
      const bushBlocked = this.world.bushes.some((bush) => Math.hypot(x - bush.x, z - bush.z) < bush.r + 1.55);
      const metrics = forestCoreMetrics(this.world, x, z);
      if (ground <= WATER_Y + 4.5 || slope > 0.4 || bushBlocked ||
        metrics.nearbyTrees < 28 || metrics.coveredTreeSectors < 7 || metrics.dryLandSectors < 8 ||
        metrics.buildingDistance < 70 || metrics.roadDistance < 80 || metrics.lumberyardDistance < 120 ||
        metrics.shorelineClearance < 44 ||
        !this.world.pointFree(x, z, 1.55, WATER_Y + 0.35, 16)) continue;
      const score = Math.hypot(x - coreX, z - coreZ) * 0.6 + slope * 20 -
        metrics.nearbyTrees * 2.4 - metrics.coveredTreeSectors * 3.2 -
        Math.min(metrics.buildingDistance, 110) * 0.08 - Math.min(metrics.lumberyardDistance, 130) * 0.06;
      if (score >= bestScore) continue;
      bestScore = score;
      chosenX = x;
      chosenZ = z;
    }
    if (!Number.isFinite(bestScore)) {
      throw new Error('树林宝箱没有找到远离建筑和道路的安全生成点');
    }
    const ground = this.world.getHeight(chosenX, chosenZ);
    const built = buildForestTreasure();
    built.group.position.set(chosenX, ground, chosenZ);
    this.root.add(built.group);
    this.world.addCollider({
      kind: 'aabb',
      minX: chosenX - 0.77, minY: ground, minZ: chosenZ - 0.5,
      maxX: chosenX + 0.77, maxY: ground + 1.2, maxZ: chosenZ + 0.5,
      tag: 'wall',
    });
    return {
      group: built.group,
      lid: built.lid,
      loot: built.loot,
      pos: new THREE.Vector3(chosenX, ground, chosenZ),
      opened: false,
      lidT: 0,
    };
  }

  private spawnTigers(): void {
    const center = this.treasure.pos;
    let placed = 0;
    for (let attempt = 0; attempt < 96 && placed < WILDLIFE_COUNTS.tiger; attempt++) {
      const angle = attempt * 2.399963 + placed * Math.PI;
      const distance = 4.1 + (attempt % 4) * 0.65;
      const x = center.x + Math.sin(angle) * distance;
      const z = center.z + Math.cos(angle) * distance;
      if (this.terrainSlope(x, z) > 0.5 || !this.world.pointFree(x, z, 1.15, WATER_Y + 0.3, 18)) continue;
      const y = this.world.getHeight(x, z);
      const built = buildTiger();
      this.addEntity('tiger', built, x, y, z, 1.08, 0.98, 140, Math.atan2(center.x - x, center.z - z));
      const tiger = this.entities[this.entities.length - 1] as WildlifeEntity;
      tiger.attackCooldown = placed * 0.72;
      placed++;
    }
    if (placed !== WILDLIFE_COUNTS.tiger) {
      throw new Error(`树林守护老虎生成失败: ${placed}/${WILDLIFE_COUNTS.tiger}`);
    }
  }

  private spawnLandAnimals(): void {
    const total = WILDLIFE_COUNTS.cow + WILDLIFE_COUNTS.sheep;
    let placed = 0;
    for (let attempt = 0; attempt < 180 && placed < total; attempt++) {
      const angle = attempt * 2.399963 + 0.35;
      const distance = 19 + (attempt % 9) * 4.4;
      const x = -40 + Math.cos(angle) * distance;
      const z = 200 + Math.sin(angle) * distance * 0.76;
      const kind: WildlifeKind = placed < WILDLIFE_COUNTS.cow ? 'cow' : 'sheep';
      const radius = kind === 'cow' ? 1.05 : 0.72;
      if (this.terrainSlope(x, z) > 0.5 || !this.world.pointFree(x, z, radius + 0.35, WATER_Y + 0.3, 18)) continue;
      const y = this.world.getHeight(x, z);
      const built = kind === 'cow' ? buildCow(placed) : buildSheep();
      this.addEntity(kind, built, x, y, z, radius, kind === 'cow' ? 0.92 : 0.72,
        kind === 'cow' ? 115 : 72, angle + Math.PI * 0.5);
      placed++;
    }
  }

  private spawnFish(): void {
    for (let i = 0; i < WILDLIFE_COUNTS.fish; i++) {
      const school = Math.floor(i / 3);
      const member = i % 3;
      let x = -165 + school * 78 + (member - 1) * 2.7;
      let z = riverZAt(x) + (member - 1) * 2.25;
      if (this.world.getHeight(x, z) > WATER_Y - 0.45) {
        x = 190 + (i % 5) * 12;
        z = -255 + Math.floor(i / 5) * 9;
      }
      const built = buildFish(i);
      built.group.scale.setScalar(1.24);
      this.addEntity('fish', built, x, WATER_Y - 0.06 - (i % 3) * 0.02, z,
        0.62, 0, 28, (i * 1.77) % (Math.PI * 2));
    }
  }

  private spawnBirds(): void {
    const anchors = [
      [-40, 200], [-60, -20], [190, -220], [0, -190], [-205, 25], [165, -35],
    ] as const;
    for (let i = 0; i < WILDLIFE_COUNTS.bird; i++) {
      const anchor = anchors[i % anchors.length] as readonly [number, number];
      const x = anchor[0] + Math.cos(i * 1.43) * (14 + i % 4 * 3);
      const z = anchor[1] + Math.sin(i * 1.43) * (14 + i % 4 * 3);
      const ground = this.world.getHeight(x, z);
      const y = Math.max(WATER_Y + 16, ground + 18 + (i % 4) * 3.2);
      const built = buildBird(i);
      built.group.scale.setScalar(1.24);
      this.addEntity('bird', built, x, y, z, 0.64, 0, 20, i * 0.62);
      const entity = this.entities[this.entities.length - 1] as WildlifeEntity;
      entity.anchor.set(anchor[0], y, anchor[1]);
      entity.speed = 4.8 + (i % 4) * 0.55;
    }
  }

  reset(): void {
    this.time = 0;
    this.treasure.opened = false;
    this.treasure.lidT = 0;
    this.treasure.lid.rotation.x = 0;
    this.treasure.loot.visible = false;
    this.treasure.loot.scale.setScalar(1);
    this.treasure.loot.rotation.y = 0;
    const glow = this.treasure.group.getObjectByName('forest-treasure-glow');
    if (glow) glow.visible = false;
    let tigerIndex = 0;
    for (const entity of this.entities) {
      entity.alive = true;
      entity.hp = entity.maxHp;
      entity.deathVy = 0;
      entity.speed = entity.kind === 'bird' ? 4.8 + (this.entities.indexOf(entity) % 4) * 0.55 : 0;
      entity.attackCooldown = entity.kind === 'tiger' ? tigerIndex++ * 0.72 : 0;
      entity.attackPose = 0;
      entity.phase = this.entities.indexOf(entity) * 0.73;
      entity.group.visible = true;
      entity.group.position.copy(entity.spawn);
      entity.group.rotation.set(0, entity.heading, 0);
    }
  }

  update(
    dt: number,
    characters: readonly WildlifeCharacterBody[] = [],
    onTigerAttack?: TigerAttackHandler,
  ): void {
    this.time += dt;
    for (const spark of this.treasure.group.children.filter((child) => child.name === 'treasure-spark')) {
      const phase = Number(spark.userData.phase ?? 0);
      spark.position.y = Number(spark.userData.baseY ?? 0.5) + Math.sin(this.time * 2.6 + phase) * 0.09;
      spark.rotation.y += dt * (1.3 + phase * 0.08);
      spark.scale.setScalar(0.72 + (Math.sin(this.time * 4.2 + phase) * 0.5 + 0.5) * 0.5);
    }
    const aura = this.treasure.group.getObjectByName('treasure-aura-light') as THREE.PointLight | undefined;
    if (aura) aura.intensity = 2.15 + Math.sin(this.time * 2.1) * 0.38;
    const halo = this.treasure.group.getObjectByName('treasure-golden-halo');
    if (halo) {
      halo.rotation.z = this.time * 0.22;
      halo.scale.setScalar(0.96 + Math.sin(this.time * 1.8) * 0.045);
    }
    if (this.treasure.opened && this.treasure.lidT < 1) {
      this.treasure.lidT = Math.min(1, this.treasure.lidT + dt * 2.3);
      this.treasure.lid.rotation.x = -1.72 * this.treasure.lidT;
      const reveal = Math.max(0, Math.min(1, (this.treasure.lidT - 0.22) / 0.28));
      const collect = Math.max(0, Math.min(1, (this.treasure.lidT - 0.72) / 0.28));
      this.treasure.loot.visible = reveal > 0 && collect < 1;
      this.treasure.loot.scale.setScalar(reveal * (1 - collect));
      this.treasure.loot.rotation.y += dt * 1.4;
    }
    for (let index = 0; index < this.entities.length; index++) {
      const entity = this.entities[index] as WildlifeEntity;
      if (!entity.alive) {
        this.updateDead(entity, dt);
        continue;
      }
      entity.phase += dt * (1.4 + entity.speed * 0.45);
      if (entity.kind === 'bird') this.updateBird(entity, index, dt);
      else if (entity.kind === 'fish') this.updateFish(entity, index, dt);
      else if (entity.kind === 'tiger') this.updateTiger(entity, index, dt, characters, onTigerAttack);
      else this.updateGrazer(entity, index, dt);
    }
    this.separateLandAnimals();
  }

  nearestClosedTreasure(x: number, y: number, z: number, maxDistance: number): ForestTreasure | null {
    if (this.treasure.opened) return null;
    const dx = this.treasure.pos.x - x;
    const dy = this.treasure.pos.y + 0.55 - y;
    const dz = this.treasure.pos.z - z;
    return dx * dx + dy * dy + dz * dz <= maxDistance * maxDistance ? this.treasure : null;
  }

  openTreasure(): boolean {
    if (this.treasure.opened) return false;
    this.treasure.opened = true;
    const glow = this.treasure.group.getObjectByName('forest-treasure-glow');
    if (glow) glow.visible = true;
    return true;
  }

  // 角色和陆生动物都使用圆形脚底实体。双方共同退让，避免玩家把动物当成静态墙，
  // 同时在动物靠近建筑时把更多修正量交给角色，防止把动物挤进墙体。
  resolveCharacterCollisions(characters: readonly WildlifeCharacterBody[]): void {
    for (const character of characters) {
      if (!character.alive || character.swimming) continue;
      for (let index = 0; index < this.entities.length; index++) {
        const entity = this.entities[index] as WildlifeEntity;
        if (!entity.alive || !this.isLandAnimal(entity)) continue;
        if (Math.abs(character.pos.y - entity.group.position.y) > 2.1) continue;
        let dx = character.pos.x - entity.group.position.x;
        let dz = character.pos.z - entity.group.position.z;
        let distance = Math.hypot(dx, dz);
        const minimum = character.radius + this.collisionRadius(entity);
        if (distance >= minimum) continue;
        if (distance < 0.001) {
          const angle = entity.phase + index * 1.37;
          dx = Math.sin(angle);
          dz = Math.cos(angle);
          distance = 1;
        }
        const nx = dx / distance;
        const nz = dz / distance;
        const overlap = minimum - distance + 0.006;
        const animalShare = 0.34;
        const animalX = entity.group.position.x - nx * overlap * animalShare;
        const animalZ = entity.group.position.z - nz * overlap * animalShare;
        const animalMoved = this.moveLandEntityIfFree(entity, animalX, animalZ);
        const characterShare = animalMoved ? 1 - animalShare : 1;
        character.pos.x += nx * overlap * characterShare;
        character.pos.z += nz * overlap * characterShare;
        this.world.resolveCollision(character.pos, character.radius);

        // 墙角可能把角色的第一次修正推回动物身边，剩余重叠改由动物承担。
        const remainDx = character.pos.x - entity.group.position.x;
        const remainDz = character.pos.z - entity.group.position.z;
        const remainDistance = Math.hypot(remainDx, remainDz);
        if (remainDistance < minimum - 0.003) {
          const rnx = remainDistance > 0.001 ? remainDx / remainDistance : nx;
          const rnz = remainDistance > 0.001 ? remainDz / remainDistance : nz;
          this.moveLandEntityIfFree(
            entity,
            entity.group.position.x - rnx * (minimum - remainDistance + 0.006),
            entity.group.position.z - rnz * (minimum - remainDistance + 0.006),
          );
        }
      }
    }
  }

  // 陆生动物与活动载具使用同一套朝向车身碰撞。鱼和飞鸟处于不同高度层，不参与。
  resolveVehicleCollisions(vehicles: readonly Vehicle[]): void {
    for (const entity of this.entities) {
      if (!entity.alive || !this.isLandAnimal(entity)) continue;
      for (const vehicle of vehicles) {
        if (vehicle.dead) continue;
        const half = VEHICLE_SPEC[vehicle.kind].half;
        if (entity.group.position.y >= vehicle.pos.y + 0.72 + half[1] ||
          entity.group.position.y + entity.centerY * 2 <= vehicle.pos.y) continue;
        const originalX = entity.group.position.x;
        const originalZ = entity.group.position.z;
        if (!resolveBodyAgainstVehicle(vehicle, entity.group.position, this.collisionRadius(entity))) continue;
        if (!this.world.pointFree(
          entity.group.position.x,
          entity.group.position.z,
          this.collisionRadius(entity),
          WATER_Y + 0.25,
          18,
        )) {
          entity.group.position.x = originalX;
          entity.group.position.z = originalZ;
        } else {
          entity.group.position.y = this.world.getHeight(entity.group.position.x, entity.group.position.z);
        }
      }
    }
  }

  private updateGrazer(entity: WildlifeEntity, index: number, dt: number): void {
    entity.decisionTimer -= dt;
    if (entity.decisionTimer <= 0) {
      entity.decisionTimer = 2.4 + (index % 5) * 0.53;
      entity.heading += Math.sin(this.time * 0.37 + index * 2.13) * 1.15;
      entity.speed = Math.sin(this.time * 0.61 + index) > -0.18
        ? entity.kind === 'cow' ? 0.42 : 0.62
        : 0;
    }
    const homeDx = entity.anchor.x - entity.group.position.x;
    const homeDz = entity.anchor.z - entity.group.position.z;
    if (homeDx * homeDx + homeDz * homeDz > 16 * 16) entity.heading = Math.atan2(homeDx, homeDz);
    const nx = entity.group.position.x + Math.sin(entity.heading) * entity.speed * dt;
    const nz = entity.group.position.z + Math.cos(entity.heading) * entity.speed * dt;
    if (entity.speed > 0 && this.terrainSlope(nx, nz) < 0.58 &&
      this.world.pointFree(nx, nz, entity.radius + 0.18, WATER_Y + 0.25, 18)) {
      entity.group.position.x = nx;
      entity.group.position.z = nz;
      entity.group.position.y = this.world.getHeight(nx, nz);
    } else if (entity.speed > 0) {
      entity.heading += Math.PI * (0.72 + (index % 3) * 0.11);
    }
    entity.group.rotation.y = entity.heading;
    for (let limb = 0; limb < Math.min(4, entity.limbs.length); limb++) {
      entity.limbs[limb]!.rotation.x = entity.speed > 0
        ? Math.sin(entity.phase * 4 + limb * Math.PI) * 0.24
        : 0;
    }
    if (entity.kind === 'cow' && entity.limbs[4]) entity.limbs[4].rotation.z = Math.sin(entity.phase * 1.7) * 0.22;
  }

  private updateTiger(
    entity: WildlifeEntity,
    index: number,
    dt: number,
    characters: readonly WildlifeCharacterBody[],
    onAttack?: TigerAttackHandler,
  ): void {
    entity.attackCooldown = Math.max(0, entity.attackCooldown - dt);
    entity.attackPose = Math.max(0, entity.attackPose - dt * 2.8);
    let target: WildlifeCharacterBody | null = null;
    let targetDistance = 22;
    for (const character of characters) {
      if (!character.alive || character.swimming || Math.abs(character.pos.y - entity.group.position.y) > 2.6) continue;
      const distance = Math.hypot(
        character.pos.x - entity.group.position.x,
        character.pos.z - entity.group.position.z,
      );
      if (distance >= targetDistance) continue;
      target = character;
      targetDistance = distance;
    }

    const homeDistance = Math.hypot(
      entity.anchor.x - entity.group.position.x,
      entity.anchor.z - entity.group.position.z,
    );
    if (target && homeDistance < 28) {
      const dx = target.pos.x - entity.group.position.x;
      const dz = target.pos.z - entity.group.position.z;
      entity.heading = Math.atan2(dx, dz);
      entity.speed = targetDistance > 1.45 ? 4.5 : 0;
      if (targetDistance <= 1.65 && entity.attackCooldown <= 0) {
        entity.attackCooldown = 1.45;
        entity.attackPose = 1;
        onAttack?.(target, 16, entity);
      }
    } else {
      entity.decisionTimer -= dt;
      if (homeDistance > 7.5) {
        entity.heading = Math.atan2(entity.anchor.x - entity.group.position.x, entity.anchor.z - entity.group.position.z);
        entity.speed = 1.7;
      } else if (entity.decisionTimer <= 0) {
        entity.decisionTimer = 2.2 + (index % 3) * 0.7;
        entity.heading += Math.sin(this.time * 0.51 + index * 1.73) * 1.25;
        entity.speed = 0.8;
      }
    }

    if (entity.speed > 0) {
      const step = entity.speed * dt;
      const tryMove = (heading: number): boolean => {
        const nx = entity.group.position.x + Math.sin(heading) * step;
        const nz = entity.group.position.z + Math.cos(heading) * step;
        if (this.terrainSlope(nx, nz) >= 0.62 || !this.world.pointFree(
          nx, nz, this.collisionRadius(entity), WATER_Y + 0.25, 18,
        )) return false;
        entity.heading = heading;
        return this.moveLandEntityIfFree(entity, nx, nz);
      };
      if (!tryMove(entity.heading) && !tryMove(entity.heading + 0.72) && !tryMove(entity.heading - 0.72)) {
        entity.heading += 1.15;
      }
    }
    entity.group.rotation.y = entity.heading;
    const run = Math.min(1, entity.speed / 4.5);
    for (let limb = 0; limb < Math.min(4, entity.limbs.length); limb++) {
      const front = limb % 2 === 1;
      const gait = Math.sin(entity.phase * (3.8 + run * 2.4) + (front ? Math.PI : 0));
      entity.limbs[limb]!.rotation.x = gait * (0.18 + run * 0.42) - entity.attackPose * (front ? 0.72 : -0.12);
    }
    if (entity.limbs[4]) entity.limbs[4].rotation.y = Math.sin(entity.phase * 2.1) * 0.42;
    entity.group.rotation.x = -Math.sin(entity.attackPose * Math.PI) * 0.18;
  }

  private updateFish(entity: WildlifeEntity, index: number, dt: number): void {
    entity.speed = 0.72 + (index % 4) * 0.12;
    entity.heading += Math.sin(this.time * 0.42 + index) * dt * 0.22;
    const dx = entity.anchor.x - entity.group.position.x;
    const dz = entity.anchor.z - entity.group.position.z;
    if (dx * dx + dz * dz > 12 * 12) entity.heading = Math.atan2(dx, dz);
    const nx = entity.group.position.x + Math.sin(entity.heading) * entity.speed * dt;
    const nz = entity.group.position.z + Math.cos(entity.heading) * entity.speed * dt;
    if (this.world.getHeight(nx, nz) < WATER_Y - 0.38) {
      entity.group.position.x = nx;
      entity.group.position.z = nz;
    } else {
      entity.heading += Math.PI * 0.82;
    }
    entity.group.position.y = WATER_Y - 0.06 - (index % 3) * 0.02 + Math.sin(entity.phase * 1.8) * 0.02;
    entity.group.rotation.y = entity.heading;
    if (entity.limbs[0]) entity.limbs[0].rotation.y = Math.sin(entity.phase * 7) * 0.42;
  }

  private updateBird(entity: WildlifeEntity, index: number, dt: number): void {
    const orbitRadius = 14 + (index % 4) * 3;
    entity.heading += dt * entity.speed / orbitRadius;
    entity.group.position.set(
      entity.anchor.x + Math.cos(entity.heading) * orbitRadius,
      entity.anchor.y + Math.sin(entity.phase * 0.48) * 1.7,
      entity.anchor.z + Math.sin(entity.heading) * orbitRadius,
    );
    entity.group.rotation.y = -entity.heading;
    for (let wing = 0; wing < entity.limbs.length; wing++) {
      entity.limbs[wing]!.rotation.z = (wing === 0 ? 1 : -1) * (0.16 + Math.sin(entity.phase * 8.5) * 0.58);
    }
  }

  private updateDead(entity: WildlifeEntity, dt: number): void {
    if (entity.kind === 'bird') {
      entity.deathVy -= 12 * dt;
      entity.group.position.y += entity.deathVy * dt;
      const ground = this.world.getHeight(entity.group.position.x, entity.group.position.z);
      if (entity.group.position.y <= ground + 0.12) {
        entity.group.position.y = ground + 0.12;
        entity.deathVy = 0;
        entity.group.rotation.z += (Math.PI * 0.5 - entity.group.rotation.z) * Math.min(1, dt * 7);
      } else {
        entity.group.rotation.x += dt * 4.2;
      }
    } else if (entity.kind === 'fish') {
      entity.group.rotation.z += (Math.PI - entity.group.rotation.z) * Math.min(1, dt * 4.5);
      entity.group.position.y += (WATER_Y - 0.08 - entity.group.position.y) * Math.min(1, dt * 1.8);
    } else {
      entity.group.rotation.z += (Math.PI * 0.5 - entity.group.rotation.z) * Math.min(1, dt * 5.5);
    }
  }

  private collisionRadius(entity: WildlifeEntity): number {
    if (entity.kind === 'cow') return entity.radius * 0.78;
    if (entity.kind === 'tiger') return entity.radius * 0.86;
    return entity.radius * 0.82;
  }

  private isLandAnimal(entity: WildlifeEntity): boolean {
    return entity.kind === 'cow' || entity.kind === 'sheep' || entity.kind === 'tiger';
  }

  private moveLandEntityIfFree(entity: WildlifeEntity, x: number, z: number): boolean {
    if (!this.world.pointFree(x, z, this.collisionRadius(entity), WATER_Y + 0.25, 18)) return false;
    entity.group.position.x = x;
    entity.group.position.z = z;
    entity.group.position.y = this.world.getHeight(x, z);
    return true;
  }

  private separateLandAnimals(): void {
    for (let i = 0; i < this.entities.length; i++) {
      const a = this.entities[i] as WildlifeEntity;
      if (!a.alive || !this.isLandAnimal(a)) continue;
      for (let j = i + 1; j < this.entities.length; j++) {
        const b = this.entities[j] as WildlifeEntity;
        if (!b.alive || !this.isLandAnimal(b)) continue;
        let dx = b.group.position.x - a.group.position.x;
        let dz = b.group.position.z - a.group.position.z;
        let distance = Math.hypot(dx, dz);
        const minimum = this.collisionRadius(a) + this.collisionRadius(b);
        if (distance >= minimum) continue;
        if (distance < 0.001) {
          const angle = a.phase + j * 1.61;
          dx = Math.sin(angle);
          dz = Math.cos(angle);
          distance = 1;
        }
        const nx = dx / distance;
        const nz = dz / distance;
        const push = (minimum - distance + 0.006) * 0.5;
        this.moveLandEntityIfFree(a, a.group.position.x - nx * push, a.group.position.z - nz * push);
        this.moveLandEntityIfFree(b, b.group.position.x + nx * push, b.group.position.z + nz * push);
      }
    }
  }

  private terrainSlope(x: number, z: number): number {
    const dx = this.world.getHeight(x + 0.65, z) - this.world.getHeight(x - 0.65, z);
    const dz = this.world.getHeight(x, z + 0.65) - this.world.getHeight(x, z - 0.65);
    return Math.hypot(dx, dz) / 1.3;
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxT: number): WildlifeHit | null {
    let best = maxT;
    let target: WildlifeEntity | null = null;
    for (const entity of this.entities) {
      if (!entity.alive || !entity.group.visible) continue;
      const t = raySphere(
        origin,
        direction,
        entity.group.position.x,
        entity.group.position.y + entity.centerY,
        entity.group.position.z,
        entity.radius,
      );
      if (t < best) {
        best = t;
        target = entity;
      }
    }
    if (!target) return null;
    return {
      entity: target,
      t: best,
      point: origin.clone().addScaledVector(direction, best),
    };
  }

  meleeTarget(
    x: number,
    y: number,
    z: number,
    forwardX: number,
    forwardZ: number,
    range: number,
  ): WildlifeMeleeTarget | null {
    let target: WildlifeEntity | null = null;
    let bestDistance = range;
    for (const entity of this.entities) {
      if (!entity.alive || !entity.group.visible) continue;
      const centerY = entity.group.position.y + entity.centerY;
      if (Math.abs(centerY - (y + 1.05)) > entity.radius + 1.05) continue;
      const dx = entity.group.position.x - x;
      const dz = entity.group.position.z - z;
      const centerDistance = Math.hypot(dx, dz);
      const edgeDistance = Math.max(0, centerDistance - entity.radius * 0.62);
      if (edgeDistance > bestDistance) continue;
      if (centerDistance > 0.01 && (dx * forwardX + dz * forwardZ) / centerDistance < 0.78) continue;
      target = entity;
      bestDistance = edgeDistance;
    }
    return target ? { entity: target, distance: bestDistance } : null;
  }

  damage(entity: WildlifeEntity, damage: number): boolean {
    if (!entity.alive || damage <= 0) return false;
    entity.hp = Math.max(0, entity.hp - damage);
    if (entity.hp > 0) return false;
    entity.alive = false;
    entity.speed = 0;
    entity.deathVy = 0;
    return true;
  }

  count(kind: WildlifeKind, aliveOnly = false): number {
    return this.entities.filter((entity) => entity.kind === kind && (!aliveOnly || entity.alive)).length;
  }
}

export function wildlifeLabel(kind: WildlifeKind): string {
  switch (kind) {
    case 'cow': return '牛';
    case 'sheep': return '羊';
    case 'fish': return '鱼';
    case 'bird': return '飞鸟';
    case 'tiger': return '守护老虎';
  }
}
