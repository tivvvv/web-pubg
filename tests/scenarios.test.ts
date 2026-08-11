import { describe, expect, it } from 'vitest';
import {
  parseCombatHealth, parseCombatMagazine, parseScenarioId, RELEASE_SCENARIO_ROUTES, releaseScenarioHref,
  SCENARIO_IDS,
} from '../src/testscenario';

describe('固定回归场景入口', () => {
  it('所有正式场景 id 均能稳定解析', () => {
    expect(SCENARIO_IDS).toEqual([
      'stairs', 'swim', 'botswim', 'combat', 'effects', 'bottactics', 'botvehicle', 'squadcommand', 'stability', 'parachute', 'vehicle', 'deathcrate', 'bombardment', 'revive', 'zone', 'endgame', 'defeat', 'wildlife', 'maptour',
    ]);
    for (const id of SCENARIO_IDS) expect(parseScenarioId(id)).toBe(id);
  });

  it('发布巡检矩阵覆盖全部核心场景和六个地图区域', () => {
    for (const id of SCENARIO_IDS) {
      expect(RELEASE_SCENARIO_ROUTES.some((route) => route.includes(`scenario=${id}`))).toBe(true);
    }
    for (const region of ['stonegate', 'ironring', 'sunfield', 'mistwood', 'eagleridge', 'tideharbor']) {
      expect(RELEASE_SCENARIO_ROUTES.some((route) => route.includes(`region=${region}`))).toBe(true);
    }
    expect(RELEASE_SCENARIO_ROUTES.filter((route) => route.includes('scenario=stability'))).toHaveLength(3);
    expect(RELEASE_SCENARIO_ROUTES.filter((route) => route.includes('scenario=stability'))
      .every((route) => route.includes('rounds=3'))).toBe(true);
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=facade&arch=apartment&plot=last');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&slice=1&view=facade');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&slice=1&view=interior');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=interior&arch=cottage1&plot=last');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=roof&arch=cottage1');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=entrance&arch=apartment&plot=last&side=inside&open=both');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=entrance&arch=barn&side=inside');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&traverse=up&arch=terrace');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&traverse=up&arch=cottage2&stance=crouch');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&traverse=up&arch=apartment&plot=last');
    for (const arch of ['terrace', 'barn', 'shop', 'gym']) {
      expect(RELEASE_SCENARIO_ROUTES).toContain(`scenario=stairs&view=facade&arch=${arch}`);
    }
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=interior&arch=gym');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=stairs&view=entrance&arch=gym&face=front&side=outside&open=both');
    for (const face of ['left', 'right']) {
      expect(RELEASE_SCENARIO_ROUTES).toContain(`scenario=stairs&view=entrance&arch=gym&face=${face}&side=inside&open=both`);
    }
    for (const sight of ['scope2', 'scope4', 'reddot']) {
      const route = RELEASE_SCENARIO_ROUTES.find((candidate) =>
        candidate.includes('scenario=combat') &&
        (sight === 'scope2' ? candidate.includes('weapon=rifle') : candidate.includes(`sight=${sight}`)),
      );
      expect(route).toContain('ads=1');
    }
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=combat&weapon=rifle&movement=run');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=combat&weapon=rifle&action=pickup&hold=1');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=revive&ai=1');
    expect(RELEASE_SCENARIO_ROUTES).toContain('scenario=parachute&stress=1');
    expect(releaseScenarioHref(0)).toContain('release=1&case=0');
    expect(releaseScenarioHref(999)).toContain(`case=${RELEASE_SCENARIO_ROUTES.length - 1}`);
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

  it('枪战场景测试血量始终限制在存活范围', () => {
    expect(parseCombatHealth(null)).toBe(100);
    expect(parseCombatHealth('20')).toBe(20);
    expect(parseCombatHealth('200')).toBe(100);
    expect(parseCombatHealth('0')).toBe(1);
    expect(parseCombatHealth('invalid')).toBe(100);
  });
});
