import { describe, expect, it } from 'vitest';
import { parseScenarioId, SCENARIO_IDS } from '../src/testscenario';

describe('固定回归场景入口', () => {
  it('所有正式场景 id 均能稳定解析', () => {
    expect(SCENARIO_IDS).toEqual([
      'stairs', 'swim', 'combat', 'bottactics', 'parachute', 'vehicle', 'deathcrate', 'bombardment', 'revive', 'zone', 'endgame', 'defeat', 'maptour',
    ]);
    for (const id of SCENARIO_IDS) expect(parseScenarioId(id)).toBe(id);
  });

  it('缺失或未知场景回退枪战场景', () => {
    expect(parseScenarioId(null)).toBe('combat');
    expect(parseScenarioId('unknown')).toBe('combat');
  });
});
