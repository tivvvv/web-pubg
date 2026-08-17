import type { Character } from './character';
import { hostileTo, sameSquad, squadFormationPoint } from './squads';

export const ENEMY_SQUAD_CONTACT_TTL = 7.5;

export interface EnemySquadContact {
  readonly squadId: number;
  readonly targetId: number;
  readonly reporterId: number;
  readonly reportedAt: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface EnemySquadSnapshot {
  readonly squadId: number;
  readonly members: readonly Character[];
  readonly alive: readonly Character[];
  readonly centerX: number;
  readonly centerZ: number;
}

export function enemySquadSnapshots(chars: readonly Character[]): EnemySquadSnapshot[] {
  const grouped = new Map<number, Character[]>();
  for (const char of chars) {
    if (char.squadId <= 0) continue;
    const members = grouped.get(char.squadId) ?? [];
    members.push(char);
    grouped.set(char.squadId, members);
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([squadId, members]) => {
    const alive = members.filter((member) => member.alive);
    const positioned = alive.length > 0 ? alive : members;
    return {
      squadId,
      members,
      alive,
      centerX: positioned.reduce((sum, member) => sum + member.pos.x, 0) / Math.max(1, positioned.length),
      centerZ: positioned.reduce((sum, member) => sum + member.pos.z, 0) / Math.max(1, positioned.length),
    };
  });
}

export class EnemySquadSystem {
  private readonly contacts = new Map<number, EnemySquadContact>();

  reset(): void {
    this.contacts.clear();
  }

  report(observer: Character, target: Character, now: number): void {
    if (!observer.alive || !target.alive || observer.squadId <= 0 || !hostileTo(observer, target)) return;
    this.contacts.set(observer.squadId, {
      squadId: observer.squadId,
      targetId: target.id,
      reporterId: observer.id,
      reportedAt: now,
      x: target.pos.x,
      y: target.pos.y,
      z: target.pos.z,
    });
  }

  update(now: number, chars: readonly Character[]): void {
    for (const [squadId, contact] of this.contacts) {
      const observer = chars.find((candidate) => candidate.alive && candidate.squadId === squadId);
      const target = chars.find((candidate) => candidate.id === contact.targetId);
      if (!observer || !target?.alive || !hostileTo(observer, target) ||
        now - contact.reportedAt > ENEMY_SQUAD_CONTACT_TTL) {
        this.contacts.delete(squadId);
      }
    }
  }

  contactFor(observer: Character, now: number, chars: readonly Character[], maxDistance = 125): EnemySquadContact | null {
    const contact = this.contacts.get(observer.squadId);
    if (!contact || now - contact.reportedAt > ENEMY_SQUAD_CONTACT_TTL) return null;
    const target = chars.find((candidate) => candidate.id === contact.targetId);
    if (!target?.alive || !hostileTo(observer, target)) return null;
    if (Math.hypot(contact.x - observer.pos.x, contact.z - observer.pos.z) > maxDistance) return null;
    return contact;
  }

  nearestKnocked(observer: Character, chars: readonly Character[], maxDistance: number): Character | null {
    let nearest: Character | null = null;
    let best = maxDistance;
    for (const candidate of chars) {
      if (!candidate.alive || !candidate.knocked || candidate === observer || !sameSquad(observer, candidate)) continue;
      if (candidate.rescuerId !== 0 && candidate.rescuerId !== observer.id) continue;
      const distance = Math.hypot(candidate.pos.x - observer.pos.x, candidate.pos.z - observer.pos.z);
      if (distance >= best) continue;
      nearest = candidate;
      best = distance;
    }
    return nearest;
  }

  regroupPoint(observer: Character, chars: readonly Character[], maxSeparation = 30): { x: number; z: number } | null {
    const leaders = chars.filter((candidate) => candidate.alive && !candidate.knocked && sameSquad(observer, candidate));
    if (leaders.length <= 1) return null;
    const leader = leaders.reduce((best, candidate) => (
      candidate.squadSlot < best.squadSlot ? candidate : best
    ));
    const distance = Math.hypot(leader.pos.x - observer.pos.x, leader.pos.z - observer.pos.z);
    if (leader === observer || distance <= maxSeparation) return null;
    return squadFormationPoint(leader.pos.x, leader.pos.z, observer.squadId, observer.squadSlot, 4.5);
  }

  get activeContactCount(): number {
    return this.contacts.size;
  }
}
