import { describe, expect, it } from 'vitest';
import { parseCombatMagazine, parseScenarioId, SCENARIO_IDS } from '../src/testscenario';

describe('固定回归场景入口', () => {
  it('所有正式场景 id 均能稳定解析', () => {
    expect(SCENARIO_IDS).toEqual([
      'stairs', 'swim', 'botswim', 'combat', 'bottactics', 'botvehicle', 'squadcommand', 'stability', 'parachute', 'vehicle', 'deathcrate', 'bombardment', 'revive', 'zone', 'endgame', 'defeat', 'maptour',
    ]);
    for (const id of SCENARIO_IDS) expect(parseScenarioId(id)).toBe(id);
  });

  it('缺失或未知场景回退枪战场景', () => {
    expect(parseScenarioId(null)).toBe('combat');
    expect(parseScenarioId('unknown')).toBe('combat');
  });

  it('枪战场景未传弹匣参数时保持满弹', () => {
    expect(parseCombatMagazine(null, 40)).toBe(40);
    expect(parseCombatMagazine('1', 40)).toBe(1);
    expect(parseCombatMagazine('200', 40)).toBe(40);
    expect(parseCombatMagazine('invalid', 40)).toBe(40);
    expect(parseCombatMagazine('-1', 40)).toBe(40);
  });
});
