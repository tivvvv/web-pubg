export interface StabilityActorSample {
  id: number;
  name: string;
  alive: boolean;
  active: boolean;
  trackMovement: boolean;
  x: number;
  y: number;
  z: number;
  hp: number;
  mode: string;
}

interface ActorHistory {
  anchorX: number;
  anchorZ: number;
  anchorTime: number;
  lastMode: string;
}

export interface StabilitySummary {
  issues: readonly string[];
  maxStagnantSec: number;
  transitions: number;
  samples: number;
  alive: number;
}

export class MatchStabilityMonitor {
  private readonly issues = new Set<string>();
  private readonly actors = new Map<number, ActorHistory>();
  private lastAlive = Number.POSITIVE_INFINITY;
  private maxStagnantSec = 0;
  private transitions = 0;
  private samples = 0;
  private readonly stuckLimitSec: number;
  private readonly movementRadius: number;

  constructor(stuckLimitSec = 10, movementRadius = 0.8) {
    this.stuckLimitSec = stuckLimitSec;
    this.movementRadius = movementRadius;
  }

  update(now: number, samples: readonly StabilityActorSample[]): StabilitySummary {
    this.samples++;
    let alive = 0;
    for (const actor of samples) {
      if (!actor.alive) {
        this.actors.delete(actor.id);
        continue;
      }
      alive++;
      if (![actor.x, actor.y, actor.z, actor.hp].every(Number.isFinite)) {
        this.issues.add(`non-finite:${actor.id}`);
        continue;
      }
      if (actor.hp <= 0 || (actor.active &&
        (Math.abs(actor.x) > 430 || Math.abs(actor.z) > 430 || actor.y < -30 || actor.y > 420))) {
        this.issues.add(`invalid-state:${actor.id}`);
      }
      let history = this.actors.get(actor.id);
      if (!history) {
        history = { anchorX: actor.x, anchorZ: actor.z, anchorTime: now, lastMode: actor.mode };
        this.actors.set(actor.id, history);
      }
      if (history.lastMode !== actor.mode) {
        history.lastMode = actor.mode;
        this.transitions++;
      }
      if (!actor.active || !actor.trackMovement) {
        history.anchorX = actor.x;
        history.anchorZ = actor.z;
        history.anchorTime = now;
        continue;
      }
      const moved = Math.hypot(actor.x - history.anchorX, actor.z - history.anchorZ);
      if (moved >= this.movementRadius) {
        history.anchorX = actor.x;
        history.anchorZ = actor.z;
        history.anchorTime = now;
        continue;
      }
      const stagnant = Math.max(0, now - history.anchorTime);
      this.maxStagnantSec = Math.max(this.maxStagnantSec, stagnant);
      if (stagnant >= this.stuckLimitSec) this.issues.add(`stuck:${actor.id}:${actor.mode}`);
    }
    if (alive > this.lastAlive) this.issues.add(`alive-count-increased:${this.lastAlive}:${alive}`);
    this.lastAlive = alive;
    return this.summary(alive);
  }

  summary(alive = Number.isFinite(this.lastAlive) ? this.lastAlive : 0): StabilitySummary {
    return {
      issues: [...this.issues],
      maxStagnantSec: this.maxStagnantSec,
      transitions: this.transitions,
      samples: this.samples,
      alive,
    };
  }
}

export interface StabilityResourceSnapshot {
  characters: number;
  bots: number;
  lootItems: number;
  lootPool: number;
  vehicles: number;
  sceneChildren: number;
  activeDeathCrates: number;
  deathCratePool: number;
}

export function validateRoundReset(
  baseline: StabilityResourceSnapshot,
  current: StabilityResourceSnapshot,
  maxDeathCrates: number,
  maxLootItems = 240,
): string[] {
  const issues: string[] = [];
  for (const key of ['characters', 'bots', 'vehicles', 'sceneChildren'] as const) {
    if (current[key] !== baseline[key]) issues.push(`resource-mismatch:${key}:${baseline[key]}:${current[key]}`);
  }
  if (current.lootItems <= 0 || current.lootItems > maxLootItems) {
    issues.push(`active-loot-items:${current.lootItems}:${maxLootItems}`);
  }
  if (current.lootPool < current.lootItems || current.lootPool > maxLootItems) {
    issues.push(`loot-pool:${current.lootPool}:${current.lootItems}:${maxLootItems}`);
  }
  if (current.activeDeathCrates !== 0) issues.push(`active-death-crates:${current.activeDeathCrates}`);
  if (current.deathCratePool > maxDeathCrates) issues.push(`death-crate-pool:${current.deathCratePool}`);
  return issues;
}

export function parseBoundedTestInteger(
  search: string,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = new URLSearchParams(search).get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
