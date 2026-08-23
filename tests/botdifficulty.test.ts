import { describe, expect, it } from 'vitest';
import {
  BOT_DIFFICULTY_PROFILES,
  botAimSigma,
  botPredatorResponse,
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
    expect(countTiers(deck)).toEqual({ rookie: 6, regular: 10, veteran: 3, elite: 1 });
    expect(deck).not.toEqual([
      ...Array<BotDifficultyTier>(6).fill('rookie'),
      ...Array<BotDifficultyTier>(10).fill('regular'),
      ...Array<BotDifficultyTier>(3).fill('veteran'),
      ...Array<BotDifficultyTier>(1).fill('elite'),
    ]);
  });

  it('人数较少时仍能完整分配且不会返回越界档位', () => {
    for (let count = 0; count <= 32; count++) {
      const deck = buildBotDifficultyDeck(count, () => 0.5);
      expect(deck).toHaveLength(count);
      for (const tier of deck) expect(BOT_DIFFICULTY_PROFILES[tier]).toBeDefined();
    }
  });

  it('六十四人对局的六十名机器人保持完整难度梯度', () => {
    const deck = buildBotDifficultyDeck(60, () => 0.5);
    expect(deck).toHaveLength(60);
    expect(countTiers(deck)).toEqual({ rookie: 18, regular: 30, veteran: 9, elite: 3 });
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

  it('机器人根据环境和战斗力判断野兽风险且水中必定躲避鳄鱼', () => {
    expect(botPredatorResponse({
      tier: 'elite', kind: 'crocodile', distance: 8, swimming: true, hp: 100, weaponTier: 4,
    })).toBe('flee');
    expect(botPredatorResponse({
      tier: 'rookie', kind: 'tiger', distance: 6, swimming: false, hp: 45, weaponTier: 0,
    })).toBe('flee');
    expect(botPredatorResponse({
      tier: 'elite', kind: 'tiger', distance: 8, swimming: false, hp: 100, weaponTier: 4,
    })).toBe('fight');
    expect(botPredatorResponse({
      tier: 'elite', kind: 'tiger', distance: 8, swimming: false, hp: 100, weaponTier: 0,
    })).toBe('flee');
    expect(botPredatorResponse({
      tier: 'regular', kind: 'crocodile', distance: 24, swimming: false, hp: 60, weaponTier: 1,
    })).toBe('ignore');
  });
});
