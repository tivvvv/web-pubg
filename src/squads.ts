import type { Character } from './character';

export const PLAYER_SQUAD_ID = 0;
export const UNASSIGNED_SQUAD_ID = -1;

export type EnemySquadRole = 'leader' | 'assault' | 'flank' | 'support';

export function squadRole(slot: number): EnemySquadRole {
  const normalized = Math.max(0, Math.min(3, Math.trunc(slot)));
  return (['leader', 'assault', 'flank', 'support'] as const)[normalized] as EnemySquadRole;
}
export function sameSquad(a: Pick<Character, 'squadId'>, b: Pick<Character, 'squadId'>): boolean {
  return a.squadId >= 0 && a.squadId === b.squadId;
}

export function hostileTo(a: Pick<Character, 'squadId'>, b: Pick<Character, 'squadId'>): boolean {
  return a.squadId < 0 || b.squadId < 0 || a.squadId !== b.squadId;
}

export function squadFormationPoint(
  targetX: number,
  targetZ: number,
  squadId: number,
  slot: number,
  spacing = 5.5,
): { x: number; z: number } {
  const role = squadRole(slot);
  if (role === 'leader') return { x: targetX, z: targetZ };
  const heading = (Math.max(0, squadId) * 2.399963229728653) % (Math.PI * 2);
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  const rightX = forwardZ;
  const rightZ = -forwardX;
  if (role === 'assault') {
    return { x: targetX + forwardX * spacing, z: targetZ + forwardZ * spacing };
  }
  if (role === 'flank') {
    return { x: targetX + rightX * spacing, z: targetZ + rightZ * spacing };
  }
  return {
    x: targetX - forwardX * spacing * 0.72 - rightX * spacing * 0.55,
    z: targetZ - forwardZ * spacing * 0.72 - rightZ * spacing * 0.55,
  };
}
