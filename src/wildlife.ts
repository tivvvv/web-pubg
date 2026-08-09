import * as THREE from 'three';
import { WATER_Y, riverZAt, type World } from './world';
import { resolveBodyAgainstVehicle, VEHICLE_SPEC, type Vehicle } from './vehicles';

export type WildlifeKind = 'cow' | 'sheep' | 'fish' | 'bird';

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

interface CharacterCollisionBody {
  readonly alive: boolean;
  readonly swimming: boolean;
  readonly radius: number;
  readonly pos: THREE.Vector3;
}

export const WILDLIFE_COUNTS: Readonly<Record<WildlifeKind, number>> = Object.freeze({
  cow: 5,
  sheep: 8,
  fish: 14,
  bird: 12,
});

const MAT = {
  cow: new THREE.MeshStandardMaterial({ color: 0x6a4430, roughness: 0.92 }),
  cowDark: new THREE.MeshStandardMaterial({ color: 0x29201b, roughness: 0.95 }),
  muzzle: new THREE.MeshStandardMaterial({ color: 0xb98d72, roughness: 0.9 }),
  horn: new THREE.MeshStandardMaterial({ color: 0xd8c9a0, roughness: 0.8 }),
  wool: new THREE.MeshStandardMaterial({ color: 0xd8d4c4, roughness: 1 }),
  sheepDark: new THREE.MeshStandardMaterial({ color: 0x38352f, roughness: 0.96 }),
  fishA: new THREE.MeshStandardMaterial({ color: 0xf0b248, roughness: 0.46, metalness: 0.08 }),
  fishB: new THREE.MeshStandardMaterial({ color: 0x5bd4d0, roughness: 0.42, metalness: 0.12 }),
  fin: new THREE.MeshStandardMaterial({ color: 0x397c83, roughness: 0.58, side: THREE.DoubleSide }),
  bird: new THREE.MeshStandardMaterial({ color: 0x3f4648, roughness: 0.85, side: THREE.DoubleSide }),
  birdLight: new THREE.MeshStandardMaterial({ color: 0x9b9b8d, roughness: 0.9, side: THREE.DoubleSide }),
  beak: new THREE.MeshStandardMaterial({ color: 0xd29c3b, roughness: 0.74 }),
};

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
  const bodyMat = variant % 2 === 0 ? MAT.cow : MAT.cowDark;
  group.add(mesh(new THREE.DodecahedronGeometry(0.55, 1), bodyMat, 0, 0.95, 0, 1.55, 0.9, 0.92));
  group.add(mesh(new THREE.DodecahedronGeometry(0.36, 1), bodyMat, 0, 1.12, 0.88, 0.86, 0.82, 0.95));
  group.add(mesh(new THREE.BoxGeometry(0.48, 0.26, 0.34), MAT.muzzle, 0, 1.02, 1.18));
  // 不规则深色斑块打破单色玩具感。
  for (const [x, y, z, sx, sy] of [[-0.55, 1.08, -0.22, 0.38, 0.3], [0.48, 0.78, 0.18, 0.3, 0.26]] as const) {
    group.add(mesh(new THREE.DodecahedronGeometry(0.25, 0), variant % 2 === 0 ? MAT.cowDark : MAT.cow, x, y, z, sx, sy, 0.18));
  }
  for (const side of [-1, 1]) {
    const horn = mesh(new THREE.ConeGeometry(0.07, 0.28, 7), MAT.horn, side * 0.25, 1.45, 0.97);
    horn.rotation.z = side * 0.72;
    group.add(horn);
    const ear = mesh(new THREE.ConeGeometry(0.11, 0.25, 6), bodyMat, side * 0.34, 1.34, 0.87);
    ear.rotation.z = side * 1.25;
    group.add(ear);
  }
  const limbs: THREE.Object3D[] = [];
  for (const x of [-0.44, 0.44]) for (const z of [-0.35, 0.35]) {
    const leg = mesh(new THREE.BoxGeometry(0.16, 0.72, 0.16), MAT.cowDark, x, 0.38, z);
    group.add(leg);
    limbs.push(leg);
  }
  const tail = mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.7, 7), bodyMat, 0, 1.02, -0.82);
  tail.rotation.x = 0.58;
  group.add(tail);
  limbs.push(tail);
  return { group, limbs };
}

function buildSheep(): { group: THREE.Group; limbs: THREE.Object3D[] } {
  const group = new THREE.Group();
  group.add(mesh(new THREE.IcosahedronGeometry(0.58, 1), MAT.wool, 0, 0.82, 0, 1.22, 0.92, 0.88));
  // 多团羊毛让轮廓不再是单球。
  for (const [x, y, z, s] of [[-0.42, 0.98, 0.02, 0.36], [0.38, 1.02, -0.08, 0.34], [0, 1.18, -0.25, 0.32]] as const) {
    group.add(mesh(new THREE.IcosahedronGeometry(0.42, 1), MAT.wool, x, y, z, s / 0.42, s / 0.42, s / 0.42));
  }
  group.add(mesh(new THREE.DodecahedronGeometry(0.28, 1), MAT.sheepDark, 0, 0.94, 0.68, 0.78, 0.92, 1.1));
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.09, 0.2, 6), MAT.sheepDark, side * 0.22, 1.08, 0.67);
    ear.rotation.z = side * 1.22;
    group.add(ear);
  }
  const limbs: THREE.Object3D[] = [];
  for (const x of [-0.32, 0.32]) for (const z of [-0.25, 0.25]) {
    const leg = mesh(new THREE.BoxGeometry(0.11, 0.52, 0.11), MAT.sheepDark, x, 0.3, z);
    group.add(leg);
    limbs.push(leg);
  }
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
  const material = variant % 3 === 0 ? MAT.birdLight : MAT.bird;
  group.add(mesh(new THREE.SphereGeometry(0.24, 10, 7), material, 0, 0, 0, 0.78, 0.54, 1.35));
  group.add(mesh(new THREE.SphereGeometry(0.14, 9, 6), material, 0, 0.05, 0.32));
  const beak = mesh(new THREE.ConeGeometry(0.07, 0.22, 6), MAT.beak, 0, 0.02, 0.51);
  beak.rotation.x = Math.PI / 2;
  group.add(beak);
  const wings: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.x = side * 0.12;
    const wing = mesh(new THREE.ConeGeometry(0.38, 0.92, 3), material, side * 0.36, 0, -0.04);
    wing.rotation.z = side * Math.PI / 2;
    pivot.add(wing);
    group.add(pivot);
    wings.push(pivot);
  }
  return { group, limbs: wings };
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

export class WildlifeSystem {
  readonly root = new THREE.Group();
  readonly entities: WildlifeEntity[] = [];
  private readonly world: World;
  private time = 0;

  constructor(world: World, scene: THREE.Scene) {
    this.world = world;
    this.root.name = 'wildlife';
    scene.add(this.root);
    this.spawnLandAnimals();
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
    });
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
    for (const entity of this.entities) {
      entity.alive = true;
      entity.hp = entity.maxHp;
      entity.deathVy = 0;
      entity.speed = entity.kind === 'bird' ? 4.8 + (this.entities.indexOf(entity) % 4) * 0.55 : 0;
      entity.phase = this.entities.indexOf(entity) * 0.73;
      entity.group.visible = true;
      entity.group.position.copy(entity.spawn);
      entity.group.rotation.set(0, entity.heading, 0);
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (let index = 0; index < this.entities.length; index++) {
      const entity = this.entities[index] as WildlifeEntity;
      if (!entity.alive) {
        this.updateDead(entity, dt);
        continue;
      }
      entity.phase += dt * (1.4 + entity.speed * 0.45);
      if (entity.kind === 'bird') this.updateBird(entity, index, dt);
      else if (entity.kind === 'fish') this.updateFish(entity, index, dt);
      else this.updateGrazer(entity, index, dt);
    }
    this.separateLandAnimals();
  }

  // 角色和牛羊都使用圆形脚底实体。双方共同退让，避免玩家把动物当成静态墙，
  // 同时在动物靠近建筑时把更多修正量交给角色，防止把动物挤进墙体。
  resolveCharacterCollisions(characters: readonly CharacterCollisionBody[]): void {
    for (const character of characters) {
      if (!character.alive || character.swimming) continue;
      for (let index = 0; index < this.entities.length; index++) {
        const entity = this.entities[index] as WildlifeEntity;
        if (!entity.alive || (entity.kind !== 'cow' && entity.kind !== 'sheep')) continue;
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

  // 牛羊与活动载具使用同一套朝向车身碰撞。鱼和飞鸟处于不同高度层，不参与。
  resolveVehicleCollisions(vehicles: readonly Vehicle[]): void {
    for (const entity of this.entities) {
      if (!entity.alive || (entity.kind !== 'cow' && entity.kind !== 'sheep')) continue;
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
    return entity.kind === 'cow' ? entity.radius * 0.78 : entity.radius * 0.82;
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
      if (!a.alive || (a.kind !== 'cow' && a.kind !== 'sheep')) continue;
      for (let j = i + 1; j < this.entities.length; j++) {
        const b = this.entities[j] as WildlifeEntity;
        if (!b.alive || (b.kind !== 'cow' && b.kind !== 'sheep')) continue;
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
  }
}
