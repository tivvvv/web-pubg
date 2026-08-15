import * as THREE from 'three';
import type { Character } from './character';

export type SquadOrderKind = 'follow' | 'move' | 'hold' | 'focus';

export type SquadMateOrderState =
  | 'following' | 'moving' | 'holding' | 'focusing' | 'engaging'
  | 'flanking' | 'supporting' | 'looting' | 'reviving' | 'safety' | 'swimming' | 'riding' | 'knocked' | 'descent';

export type SquadCombatRole = 'leftFlank' | 'support' | 'rightFlank';

export interface SquadContact {
  readonly targetId: number;
  readonly reporterId: number;
  readonly reportedAt: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const SQUAD_CONTACT_TTL = 6;

export function squadNameTagPresentation(alive: boolean, modelVisible: boolean, distance: number): {
  visible: boolean;
  scale: number;
} {
  return {
    visible: alive && modelVisible && distance >= 2.5 && distance < 60,
    scale: THREE.MathUtils.clamp(distance / 24, 0.34, 1),
  };
}

export function squadCombatRole(memberIndex: number): SquadCombatRole {
  const index = Math.max(0, Math.min(2, Math.trunc(memberIndex)));
  return index === 0 ? 'leftFlank' : index === 2 ? 'rightFlank' : 'support';
}

export function squadCombatTarget(
  originX: number,
  originZ: number,
  targetX: number,
  targetZ: number,
  memberIndex: number,
  preferredDistance: number,
): { x: number; z: number } {
  const dx = originX - targetX;
  const dz = originZ - targetZ;
  const length = Math.hypot(dx, dz) || 1;
  const outwardX = dx / length;
  const outwardZ = dz / length;
  const rightX = outwardZ;
  const rightZ = -outwardX;
  const role = squadCombatRole(memberIndex);
  const side = role === 'leftFlank' ? -1 : role === 'rightFlank' ? 1 : 0;
  const radius = preferredDistance * (role === 'support' ? 1.02 : 0.86);
  const lateral = Math.min(8, Math.max(4, preferredDistance * 0.26)) * side;
  return {
    x: targetX + outwardX * radius + rightX * lateral,
    z: targetZ + outwardZ * radius + rightZ * lateral,
  };
}

export class SquadIntelSystem {
  private readonly contacts = new Map<number, SquadContact>();

  reset(): void {
    this.contacts.clear();
  }

  report(target: Character, reporterId: number, now: number): void {
    if (!target.alive || target.team !== 'enemy') return;
    this.contacts.set(target.id, {
      targetId: target.id,
      reporterId,
      reportedAt: now,
      x: target.pos.x,
      y: target.pos.y,
      z: target.pos.z,
    });
  }

  update(now: number, chars: readonly Character[]): void {
    for (const [targetId, contact] of this.contacts) {
      const target = chars.find((candidate) => candidate.id === targetId);
      if (!target?.alive || target.team !== 'enemy' || now - contact.reportedAt > SQUAD_CONTACT_TTL) {
        this.contacts.delete(targetId);
      }
    }
  }

  bestContact(observer: Character, now: number, chars: readonly Character[], maxDistance = 110): SquadContact | null {
    let best: SquadContact | null = null;
    let bestScore = Infinity;
    for (const contact of this.contacts.values()) {
      const age = now - contact.reportedAt;
      if (age < 0 || age > SQUAD_CONTACT_TTL) continue;
      const target = chars.find((candidate) => candidate.id === contact.targetId);
      if (!target?.alive || target.team !== 'enemy') continue;
      const distance = Math.hypot(contact.x - observer.pos.x, contact.z - observer.pos.z);
      if (distance > maxDistance) continue;
      const score = distance + age * 7;
      if (score < bestScore) {
        best = contact;
        bestScore = score;
      }
    }
    return best;
  }

  latestTarget(now: number, chars: readonly Character[]): Character | null {
    let latest: SquadContact | null = null;
    for (const contact of this.contacts.values()) {
      if (now - contact.reportedAt > SQUAD_CONTACT_TTL) continue;
      if (!latest || contact.reportedAt > latest.reportedAt) latest = contact;
    }
    return latest ? chars.find((candidate) => candidate.id === latest?.targetId && candidate.alive) ?? null : null;
  }

  get activeCount(): number {
    return this.contacts.size;
  }
}

export interface SquadOrder {
  readonly kind: SquadOrderKind;
  readonly serial: number;
  readonly issuedAt: number;
  readonly yaw: number;
  readonly targetId: number;
  x: number;
  y: number;
  z: number;
}

export interface SquadOrderMapState {
  kind: Exclude<SquadOrderKind, 'follow'>;
  x: number;
  z: number;
}

export const SQUAD_ORDER_LABELS: Readonly<Record<SquadOrderKind, string>> = {
  follow: '跟随队长',
  move: '前往标记并警戒',
  hold: '原地警戒',
  focus: '集中火力',
};

const FORMATION_SIDE = [-3.2, 0, 3.2] as const;
const FORMATION_BACK = [1.3, 0, 1.3] as const;

export function squadFormationTarget(
  targetX: number,
  targetZ: number,
  yaw: number,
  memberIndex: number,
): { x: number; z: number } {
  const index = Math.max(0, Math.min(2, Math.trunc(memberIndex)));
  const side = FORMATION_SIDE[index] as number;
  const back = FORMATION_BACK[index] as number;
  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  return {
    x: targetX + rightX * side - forwardX * back,
    z: targetZ + rightZ * side - forwardZ * back,
  };
}

export function squadAimScore(along: number, distanceSq: number): number | null {
  if (along <= 0 || distanceSq > 180 * 180) return null;
  const missSq = Math.max(0, distanceSq - along * along);
  const tolerance = 0.8 + along * 0.025;
  if (missSq > tolerance * tolerance) return null;
  return missSq / (tolerance * tolerance) + along / 900;
}

function makeOrderTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.translate(48, 48);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -30);
  ctx.lineTo(25, 0);
  ctx.lineTo(0, 30);
  ctx.lineTo(-25, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}

export class SquadCommandSystem {
  private serial = 0;
  private order: SquadOrder = {
    kind: 'follow', serial: 0, issuedAt: 0, yaw: 0, targetId: 0, x: 0, y: 0, z: 0,
  };
  private readonly marker = new THREE.Group();
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly iconMaterial: THREE.SpriteMaterial;

  constructor(scene: THREE.Scene) {
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xf2c94c,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.68, 0.92, 28), this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 8;

    this.beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xf2c94c,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      depthTest: false,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.2, 6), this.beamMaterial);
    beam.position.y = 1.1;
    beam.renderOrder = 8;

    this.iconMaterial = new THREE.SpriteMaterial({
      map: makeOrderTexture(),
      color: 0xf2c94c,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const icon = new THREE.Sprite(this.iconMaterial);
    icon.position.y = 2.35;
    icon.scale.set(0.52, 0.52, 1);
    icon.renderOrder = 9;
    this.marker.add(ring, beam, icon);
    this.marker.visible = false;
    scene.add(this.marker);
  }

  get current(): Readonly<SquadOrder> {
    return this.order;
  }

  issue(
    kind: SquadOrderKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    targetId: number,
    issuedAt: number,
  ): Readonly<SquadOrder> {
    this.order = { kind, x, y, z, yaw, targetId, issuedAt, serial: ++this.serial };
    this.applyVisualKind(kind);
    return this.order;
  }

  reset(x = 0, y = 0, z = 0, yaw = 0): void {
    this.issue('follow', x, y, z, yaw, 0, 0);
  }

  update(now: number, chars: readonly Character[]): boolean {
    if (this.order.kind === 'focus') {
      const target = chars.find((char) => char.id === this.order.targetId && char.alive && char.team === 'enemy');
      if (!target) {
        this.issue('follow', this.order.x, this.order.y, this.order.z, this.order.yaw, 0, now);
        return true;
      }
      this.order.x = target.pos.x;
      this.order.y = target.pos.y;
      this.order.z = target.pos.z;
    }
    if (this.order.kind === 'follow') {
      this.marker.visible = false;
      return false;
    }
    this.marker.visible = true;
    this.marker.position.set(this.order.x, this.order.y + 0.06, this.order.z);
    const pulse = 0.5 + Math.sin(now * 5.5) * 0.5;
    const scale = 0.96 + pulse * 0.16;
    this.marker.scale.set(scale, scale, scale);
    this.ringMaterial.opacity = 0.62 + pulse * 0.3;
    this.beamMaterial.opacity = 0.2 + pulse * 0.18;
    this.iconMaterial.opacity = 0.72 + pulse * 0.28;
    return false;
  }

  mapState(): SquadOrderMapState | null {
    if (this.order.kind === 'follow') return null;
    return { kind: this.order.kind, x: this.order.x, z: this.order.z };
  }

  private applyVisualKind(kind: SquadOrderKind): void {
    this.marker.visible = kind !== 'follow';
    const color = kind === 'focus' ? 0xff6b4a : kind === 'hold' ? 0x79d9ff : 0xf2c94c;
    this.ringMaterial.color.setHex(color);
    this.beamMaterial.color.setHex(color);
    this.iconMaterial.color.setHex(color);
  }
}
