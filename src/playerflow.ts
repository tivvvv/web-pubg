export type PlayerFlowTone = 'info' | 'success' | 'warning' | 'danger';

export function shouldCelebrateFirstGun(hadGun: boolean, armedAt: number): boolean {
  return !hadGun && armedAt < 0;
}

export function accumulatePlayerDamage(
  current: number,
  applied: number,
  attackerIsPlayer: boolean,
  selfDamage: boolean,
): number {
  if (!attackerIsPlayer || selfDamage || applied <= 0) return current;
  return current + applied;
}

export interface PlayerDeathInput {
  attackerName: string | null;
  via: string | null;
  headshot: boolean;
  selfInflicted: boolean;
}

export function playerDeathDetail(input: PlayerDeathInput): string {
  if (input.selfInflicted && input.via) return `你被自己的${input.via}淘汰`;
  if (input.attackerName) {
    if (input.via) return `${input.attackerName} 使用${input.via}将你淘汰`;
    return `${input.attackerName}${input.headshot ? '爆头' : ''}将你淘汰`;
  }
  if (input.via) return `你死于${input.via}`;
  return '你被安全区淘汰';
}
