export type BotDifficultyTier = 'rookie' | 'regular' | 'veteran' | 'elite';

export interface BotDifficultyProfile {
  readonly id: BotDifficultyTier;
  readonly label: string;
  readonly weight: number;
  readonly detectionDistance: number;
  readonly hearingDistance: number;
  readonly scanMin: number;
  readonly scanMax: number;
  readonly reactionMin: number;
  readonly reactionMax: number;
  readonly lostTargetSeconds: number;
  readonly aimErrorScale: number;
  readonly movingTargetErrorScale: number;
  readonly playerAimPenalty: number;
  readonly burstMin: number;
  readonly burstMax: number;
  readonly burstPauseMin: number;
  readonly burstPauseMax: number;
  readonly shotCadenceMin: number;
  readonly shotCadenceMax: number;
  readonly tacticMin: number;
  readonly tacticMax: number;
  readonly strafeFlipChance: number;
  readonly coverHpThreshold: number;
  readonly crouchChance: number;
  readonly turnSpeedScale: number;
  readonly fireAngle: number;
  readonly fragStillSeconds: number;
  readonly useSmoke: boolean;
  readonly meleeThinkMin: number;
  readonly meleeThinkMax: number;
  readonly lootScanScale: number;
  readonly lootRangeScale: number;
  readonly recoverHpThreshold: number;
  readonly fragCarryChance: number;
  readonly smokeCarryChance: number;
}

export const BOT_DIFFICULTY_PROFILES: Readonly<Record<BotDifficultyTier, BotDifficultyProfile>> = {
  rookie: {
    id: 'rookie',
    label: '新手',
    weight: 4,
    detectionDistance: 68,
    hearingDistance: 74,
    scanMin: 0.42,
    scanMax: 0.56,
    reactionMin: 0.72,
    reactionMax: 1.12,
    lostTargetSeconds: 1.8,
    aimErrorScale: 1.3,
    movingTargetErrorScale: 1.25,
    playerAimPenalty: 0.01,
    burstMin: 2,
    burstMax: 3,
    burstPauseMin: 0.9,
    burstPauseMax: 1.4,
    shotCadenceMin: 1.7,
    shotCadenceMax: 2.3,
    tacticMin: 1,
    tacticMax: 1.55,
    strafeFlipChance: 0.18,
    coverHpThreshold: 32,
    crouchChance: 0.05,
    turnSpeedScale: 0.8,
    fireAngle: 0.16,
    fragStillSeconds: Infinity,
    useSmoke: false,
    meleeThinkMin: 0.28,
    meleeThinkMax: 0.55,
    lootScanScale: 1.35,
    lootRangeScale: 0.82,
    recoverHpThreshold: 50,
    fragCarryChance: 0.12,
    smokeCarryChance: 0,
  },
  regular: {
    id: 'regular',
    label: '普通',
    weight: 9,
    detectionDistance: 88,
    hearingDistance: 105,
    scanMin: 0.28,
    scanMax: 0.38,
    reactionMin: 0.4,
    reactionMax: 0.75,
    lostTargetSeconds: 2.5,
    aimErrorScale: 1.08,
    movingTargetErrorScale: 1.05,
    playerAimPenalty: 0.007,
    burstMin: 3,
    burstMax: 5,
    burstPauseMin: 0.6,
    burstPauseMax: 1.1,
    shotCadenceMin: 1.4,
    shotCadenceMax: 1.95,
    tacticMin: 0.8,
    tacticMax: 1.35,
    strafeFlipChance: 0.32,
    coverHpThreshold: 42,
    crouchChance: 0.15,
    turnSpeedScale: 1,
    fireAngle: 0.22,
    fragStillSeconds: 2.6,
    useSmoke: true,
    meleeThinkMin: 0.12,
    meleeThinkMax: 0.28,
    lootScanScale: 1,
    lootRangeScale: 1,
    recoverHpThreshold: 58,
    fragCarryChance: 0.28,
    smokeCarryChance: 0.1,
  },
  veteran: {
    id: 'veteran',
    label: '老练',
    weight: 5,
    detectionDistance: 98,
    hearingDistance: 118,
    scanMin: 0.2,
    scanMax: 0.28,
    reactionMin: 0.24,
    reactionMax: 0.48,
    lostTargetSeconds: 3.2,
    aimErrorScale: 0.84,
    movingTargetErrorScale: 0.8,
    playerAimPenalty: 0.005,
    burstMin: 4,
    burstMax: 6,
    burstPauseMin: 0.42,
    burstPauseMax: 0.82,
    shotCadenceMin: 1.25,
    shotCadenceMax: 1.65,
    tacticMin: 0.62,
    tacticMax: 1.02,
    strafeFlipChance: 0.42,
    coverHpThreshold: 56,
    crouchChance: 0.28,
    turnSpeedScale: 1.15,
    fireAngle: 0.26,
    fragStillSeconds: 1.8,
    useSmoke: true,
    meleeThinkMin: 0.05,
    meleeThinkMax: 0.16,
    lootScanScale: 0.82,
    lootRangeScale: 1.12,
    recoverHpThreshold: 68,
    fragCarryChance: 0.45,
    smokeCarryChance: 0.28,
  },
  elite: {
    id: 'elite',
    label: '精英',
    weight: 2,
    detectionDistance: 106,
    hearingDistance: 128,
    scanMin: 0.16,
    scanMax: 0.22,
    reactionMin: 0.15,
    reactionMax: 0.3,
    lostTargetSeconds: 4,
    aimErrorScale: 0.72,
    movingTargetErrorScale: 0.68,
    playerAimPenalty: 0.004,
    burstMin: 5,
    burstMax: 7,
    burstPauseMin: 0.32,
    burstPauseMax: 0.62,
    shotCadenceMin: 1.15,
    shotCadenceMax: 1.48,
    tacticMin: 0.5,
    tacticMax: 0.82,
    strafeFlipChance: 0.5,
    coverHpThreshold: 68,
    crouchChance: 0.4,
    turnSpeedScale: 1.28,
    fireAngle: 0.3,
    fragStillSeconds: 1.2,
    useSmoke: true,
    meleeThinkMin: 0,
    meleeThinkMax: 0.08,
    lootScanScale: 0.68,
    lootRangeScale: 1.22,
    recoverHpThreshold: 76,
    fragCarryChance: 0.65,
    smokeCarryChance: 0.5,
  },
};

const DIFFICULTY_ORDER = ['rookie', 'regular', 'veteran', 'elite'] as const;

export function botDifficultyProfile(tier: BotDifficultyTier): BotDifficultyProfile {
  return BOT_DIFFICULTY_PROFILES[tier];
}

export function buildBotDifficultyDeck(
  count: number,
  randomSource: () => number,
): BotDifficultyTier[] {
  if (count <= 0) return [];
  const totalWeight = DIFFICULTY_ORDER.reduce(
    (sum, tier) => sum + BOT_DIFFICULTY_PROFILES[tier].weight,
    0,
  );
  const allocations = DIFFICULTY_ORDER.map((tier, order) => {
    const exact = count * BOT_DIFFICULTY_PROFILES[tier].weight / totalWeight;
    return { tier, order, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let assigned = allocations.reduce((sum, entry) => sum + entry.count, 0);
  const byRemainder = [...allocations].sort(
    (a, b) => b.remainder - a.remainder || a.order - b.order,
  );
  for (let index = 0; assigned < count; index++, assigned++) {
    const entry = byRemainder[index % byRemainder.length];
    if (entry) entry.count++;
  }
  const deck = allocations.flatMap(({ tier, count: tierCount }) =>
    Array.from({ length: tierCount }, () => tier));
  for (let index = deck.length - 1; index > 0; index--) {
    const swapIndex = Math.min(index, Math.floor(randomSource() * (index + 1)));
    const current = deck[index] as BotDifficultyTier;
    deck[index] = deck[swapIndex] as BotDifficultyTier;
    deck[swapIndex] = current;
  }
  return deck;
}

export function botAimSigma(
  profile: BotDifficultyProfile,
  distance: number,
  targetSpeed: number,
  targetIsPlayer: boolean,
): number {
  const movementError = targetSpeed > 5 ? 0.024 * profile.movingTargetErrorScale : 0;
  return (0.028 + distance * 0.00055 + movementError) * profile.aimErrorScale +
    (targetIsPlayer ? profile.playerAimPenalty : 0);
}
