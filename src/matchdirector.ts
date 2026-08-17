import type { Character } from './character';
import { enemySquadSnapshots, type EnemySquadSnapshot } from './enemysquads';
import type { RegionEvent } from './regionevents';
import { squadFormationPoint } from './squads';

export type DirectorDirectiveKind = 'contest' | 'intercept' | 'rotate' | 'endgame';

export interface DirectorDirective {
  readonly squadId: number;
  readonly kind: DirectorDirectiveKind;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly x: number;
  readonly z: number;
}

export interface DirectorZoneState {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly nextCenterX: number;
  readonly nextCenterZ: number;
  readonly nextRadius: number;
  readonly state: 'wait' | 'shrink' | 'done';
}

export interface MatchDirectorUpdate {
  readonly now: number;
  readonly armed: boolean;
  readonly player: Character | null;
  readonly chars: readonly Character[];
  readonly zone: DirectorZoneState;
  readonly events: readonly RegionEvent[];
  readonly pointFree: (x: number, z: number) => boolean;
}

export interface ZoneCandidateScoreInput {
  readonly phase: number;
  readonly nextRadius: number;
  readonly dryLand: boolean;
  readonly coverCount: number;
  readonly landmarkDistance: number;
}

export function scoreTacticalZoneCandidate(input: ZoneCandidateScoreInput): number {
  if (!input.dryLand) return -1000;
  const late = Math.max(0, Math.min(1, (input.phase - 1) / 3));
  const cover = Math.min(48, Math.max(0, input.coverCount));
  const landmarkReach = Math.max(18, input.nextRadius * 0.75);
  const landmark = Math.max(0, 1 - input.landmarkDistance / landmarkReach);
  return cover * (0.7 + late * 1.15) + landmark * (12 + late * 24);
}

function squadDistance(snapshot: EnemySquadSnapshot, x: number, z: number): number {
  return Math.hypot(snapshot.centerX - x, snapshot.centerZ - z);
}

function isInside(x: number, z: number, centerX: number, centerZ: number, radius: number, margin = 0): boolean {
  return Math.hypot(x - centerX, z - centerZ) <= Math.max(1, radius - margin);
}

function lanePoint(zone: DirectorZoneState, squadId: number, endgame: boolean): { x: number; z: number } {
  const angle = (squadId * 2.399963229728653) % (Math.PI * 2);
  const radius = endgame
    ? Math.max(5, Math.min(18, zone.nextRadius * 0.48))
    : Math.max(12, zone.nextRadius * 0.62);
  return {
    x: zone.nextCenterX + Math.cos(angle) * radius,
    z: zone.nextCenterZ + Math.sin(angle) * radius,
  };
}

export function choosePressureSquad(
  squads: readonly EnemySquadSnapshot[],
  playerX: number,
  playerZ: number,
  now: number,
): EnemySquadSnapshot | null {
  let best: EnemySquadSnapshot | null = null;
  let bestScore = Infinity;
  for (const squad of squads) {
    if (squad.alive.length < 2 || squad.alive.some((member) => member.knocked)) continue;
    const distance = squadDistance(squad, playerX, playerZ);
    if (distance < 72 || distance > 235) continue;
    const recentFire = squad.alive.some((member) => now - member.lastShotT < 8);
    if (recentFire) continue;
    const score = Math.abs(distance - 135) + squad.squadId * 0.01;
    if (score >= bestScore) continue;
    best = squad;
    bestScore = score;
  }
  return best;
}

export function fairInterceptPoint(
  playerX: number,
  playerZ: number,
  zone: DirectorZoneState,
  pointFree: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  let dx = zone.nextCenterX - playerX;
  let dz = zone.nextCenterZ - playerZ;
  const length = Math.hypot(dx, dz);
  if (length < 0.1) {
    dx = Math.cos((playerX + playerZ) * 0.017);
    dz = Math.sin((playerX - playerZ) * 0.017);
  } else {
    dx /= length;
    dz /= length;
  }
  for (const distance of [64, 54, 76] as const) {
    for (const side of [0, 0.42, -0.42, 0.78, -0.78] as const) {
      const cos = Math.cos(side);
      const sin = Math.sin(side);
      const x = playerX + (dx * cos - dz * sin) * distance;
      const z = playerZ + (dz * cos + dx * sin) * distance;
      if (!isInside(x, z, zone.nextCenterX, zone.nextCenterZ, zone.nextRadius, 4)) continue;
      if (pointFree(x, z)) return { x, z };
    }
  }
  return null;
}

export class MatchDirector {
  private readonly directives = new Map<number, DirectorDirective>();
  private lastPlayerEngagementAt = 0;
  private nextThinkAt = 0;
  private lastPressureAt = -100;
  private armedAt = -1;

  reset(now = 0): void {
    this.directives.clear();
    this.lastPlayerEngagementAt = now;
    this.nextThinkAt = now;
    this.lastPressureAt = -100;
    this.armedAt = -1;
  }

  recordEngagement(now: number, involvesPlayerSquad: boolean): void {
    if (involvesPlayerSquad) this.lastPlayerEngagementAt = Math.max(this.lastPlayerEngagementAt, now);
  }

  update(input: MatchDirectorUpdate): void {
    for (const [squadId, directive] of this.directives) {
      if (input.now >= directive.expiresAt) this.directives.delete(squadId);
    }
    if (!input.armed) {
      this.armedAt = -1;
      return;
    }
    if (this.armedAt < 0) {
      this.armedAt = input.now;
      this.lastPlayerEngagementAt = input.now;
      this.nextThinkAt = input.now + 8;
      return;
    }
    if (input.now < this.nextThinkAt) return;
    this.nextThinkAt = input.now + 4;

    const squads = enemySquadSnapshots(input.chars).filter((squad) => squad.alive.length > 0);
    const endgame = input.zone.radius <= 78 || squads.length <= 4;
    if (endgame) {
      for (const squad of squads) {
        const point = lanePoint(input.zone, squad.squadId, true);
        if (!input.pointFree(point.x, point.z)) continue;
        this.directives.set(squad.squadId, {
          squadId: squad.squadId,
          kind: 'endgame',
          issuedAt: input.now,
          expiresAt: input.now + 14,
          ...point,
        });
      }
      return;
    }

    // 在缩圈前后让每支队从不同方位进入下一安全区, 减少所有 AI 直冲圆心形成的人墙.
    if (input.zone.state === 'shrink') {
      for (const squad of squads) {
        if (this.directives.has(squad.squadId)) continue;
        if (isInside(squad.centerX, squad.centerZ, input.zone.nextCenterX, input.zone.nextCenterZ, input.zone.nextRadius, 8)) {
          continue;
        }
        const point = lanePoint(input.zone, squad.squadId, false);
        if (!input.pointFree(point.x, point.z)) continue;
        this.directives.set(squad.squadId, {
          squadId: squad.squadId,
          kind: 'rotate',
          issuedAt: input.now,
          expiresAt: input.now + 20,
          ...point,
        });
      }
    }

    // 让尚未接战的小队争夺已有区域事件；目标对玩家可见，因此压力来源可预判.
    for (const event of input.events) {
      if (!isInside(event.x, event.z, input.zone.centerX, input.zone.centerZ, input.zone.radius, 8)) continue;
      const alreadyContested = [...this.directives.values()].some((directive) => (
        directive.kind === 'contest' && Math.hypot(directive.x - event.x, directive.z - event.z) < 2
      ));
      if (alreadyContested) continue;
      const candidate = squads
        .filter((squad) => !this.directives.has(squad.squadId) && squad.alive.length >= 2)
        .map((squad) => ({ squad, distance: squadDistance(squad, event.x, event.z) }))
        .filter((entry) => entry.distance >= 55 && entry.distance <= 190)
        .sort((a, b) => a.distance - b.distance)[0]?.squad;
      if (!candidate) continue;
      this.directives.set(candidate.squadId, {
        squadId: candidate.squadId,
        kind: 'contest',
        issuedAt: input.now,
        expiresAt: input.now + 32,
        x: event.x,
        z: event.z,
      });
    }

    const player = input.player;
    if (!player?.alive || player.knocked) return;
    const drought = input.now - Math.max(this.armedAt, this.lastPlayerEngagementAt);
    if (drought < 38 || input.now - this.lastPressureAt < 30) return;
    const pressureSquad = choosePressureSquad(
      squads.filter((squad) => !this.directives.has(squad.squadId)),
      player.pos.x,
      player.pos.z,
      input.now,
    );
    if (!pressureSquad) return;
    const point = fairInterceptPoint(
      player.pos.x,
      player.pos.z,
      input.zone,
      input.pointFree,
    );
    if (!point) return;
    this.directives.set(pressureSquad.squadId, {
      squadId: pressureSquad.squadId,
      kind: 'intercept',
      issuedAt: input.now,
      expiresAt: input.now + 28,
      ...point,
    });
    this.lastPressureAt = input.now;
  }

  directiveFor(character: Character, now: number): DirectorDirective | null {
    const directive = this.directives.get(character.squadId);
    if (!directive || now >= directive.expiresAt) return null;
    const point = squadFormationPoint(directive.x, directive.z, character.squadId, character.squadSlot, 5.2);
    return { ...directive, ...point };
  }

  get activeDirectives(): readonly DirectorDirective[] {
    return [...this.directives.values()];
  }

  playerCombatDrought(now: number): number {
    return Math.max(0, now - Math.max(this.armedAt, this.lastPlayerEngagementAt));
  }
}
