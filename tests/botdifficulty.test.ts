import { describe, expect, it } from 'vitest';
import {
  BOT_DIFFICULTY_PROFILES,
  botAimSigma,
  buildBotDifficultyDeck,
  type BotDifficultyTier,
} from '../src/botdifficulty';

function countTiers(deck: readonly BotDifficultyTier[]): Record<BotDifficultyTier, number> {
  return {
    rookie: deck.filter((tier) => tier === 'rookie').length,
    regular: deck.filter((tier) => tier === 'regular').length,
    veteran: deck.filter((tier) => tier === 'veteran').length,
    elite: deck.filter((tier) => tier === 'elite').length,
  };
}

describe('机器人难度分层', () => {
  it('每局二十名机器人保持稳定比例并随机打散身份', () => {
    let state = 17;
    const randomSource = (): number => {
      state = state * 1664525 + 1013904223 | 0;
      return (state >>> 0) / 0x100000000;
    };
    const deck = buildBotDifficultyDeck(20, randomSource);

    expect(deck).toHaveLength(20);
    expect(countTiers(deck)).toEqual({ rookie: 4, regular: 9, veteran: 5, elite: 2 });
    expect(deck).not.toEqual([
      ...Array<BotDifficultyTier>(4).fill('rookie'),
      ...Array<BotDifficultyTier>(9).fill('regular'),
      ...Array<BotDifficultyTier>(5).fill('veteran'),
      ...Array<BotDifficultyTier>(2).fill('elite'),
    ]);
  });

  it('人数较少时仍能完整分配且不会返回越界档位', () => {
    for (let count = 0; count <= 32; count++) {
      const deck = buildBotDifficultyDeck(count, () => 0.5);
      expect(deck).toHaveLength(count);
      for (const tier of deck) expect(BOT_DIFFICULTY_PROFILES[tier]).toBeDefined();
    }
  });

  it('高阶机器人感知更远反应更快但仍保留射击误差', () => {
    const rookie = BOT_DIFFICULTY_PROFILES.rookie;
    const regular = BOT_DIFFICULTY_PROFILES.regular;
    const veteran = BOT_DIFFICULTY_PROFILES.veteran;
    const elite = BOT_DIFFICULTY_PROFILES.elite;

    expect([
      rookie.detectionDistance,
      regular.detectionDistance,
      veteran.detectionDistance,
      elite.detectionDistance,
    ]).toEqual([...[
      rookie.detectionDistance,
      regular.detectionDistance,
      veteran.detectionDistance,
      elite.detectionDistance,
    ]].sort((a, b) => a - b));
    expect(rookie.reactionMin).toBeGreaterThan(regular.reactionMin);
    expect(regular.reactionMin).toBeGreaterThan(veteran.reactionMin);
    expect(veteran.reactionMin).toBeGreaterThan(elite.reactionMin);

    const rookieSigma = botAimSigma(rookie, 45, 6, true);
    const regularSigma = botAimSigma(regular, 45, 6, true);
    const veteranSigma = botAimSigma(veteran, 45, 6, true);
    const eliteSigma = botAimSigma(elite, 45, 6, true);
    expect(rookieSigma).toBeGreaterThan(regularSigma);
    expect(regularSigma).toBeGreaterThan(veteranSigma);
    expect(veteranSigma).toBeGreaterThan(eliteSigma);
    expect(eliteSigma).toBeGreaterThan(0.04);
  });

  it('高阶机器人更积极使用掩体资源和战术动作', () => {
    const rookie = BOT_DIFFICULTY_PROFILES.rookie;
    const elite = BOT_DIFFICULTY_PROFILES.elite;
    expect(elite.coverHpThreshold).toBeGreaterThan(rookie.coverHpThreshold);
    expect(elite.crouchChance).toBeGreaterThan(rookie.crouchChance);
    expect(elite.lootScanScale).toBeLessThan(rookie.lootScanScale);
    expect(elite.lootRangeScale).toBeGreaterThan(rookie.lootRangeScale);
    expect(elite.fragCarryChance).toBeGreaterThan(rookie.fragCarryChance);
    expect(elite.smokeCarryChance).toBeGreaterThan(rookie.smokeCarryChance);
  });
});
