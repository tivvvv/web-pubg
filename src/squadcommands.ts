import * as THREE from 'three';
import type { Character } from './character';

export type SquadOrderKind = 'follow' | 'move' | 'hold' | 'focus';

export type SquadMateOrderState =
  | 'following' | 'moving' | 'holding' | 'focusing' | 'engaging'
  | 'looting' | 'reviving' | 'safety' | 'swimming' | 'riding' | 'knocked' | 'descent';

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
