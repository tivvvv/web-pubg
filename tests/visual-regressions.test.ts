import { describe, expect, it } from 'vitest';
import { advancePoseBlend, Character, ownModelVisibility } from '../src/character';
import { emptyAttachments } from '../src/attachments';
import { environmentLighting } from '../src/environment';
import { RENDER_QUALITY } from '../src/rendering';
import { WEAPONS } from '../src/weapons';
import { SUN_SHADOW_MAP_SIZE } from '../src/world';

describe('画面回归保护', () => {
  it('第一人称趴下隐藏会穿入相机的自身模型', () => {
    expect(ownModelVisibility(false, 2)).toEqual({ head: true, body: true, hands: true });
    expect(ownModelVisibility(true, 0)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1.1)).toEqual({ head: false, body: false, hands: false });
    expect(ownModelVisibility(true, 2)).toEqual({ head: false, body: false, hands: false });
  });

  it('空降, 乘车和击倒姿态以有限速率进入和退出', () => {
    const entering = advancePoseBlend(0, true, 1 / 60, 6, 4);
    expect(entering).toBeGreaterThan(0);
    expect(entering).toBeLessThan(1);
    expect(advancePoseBlend(entering, false, 1 / 60, 6, 4)).toBeLessThan(entering);
    expect(advancePoseBlend(0.98, true, 1, 6, 4)).toBe(1);
    expect(advancePoseBlend(0.02, false, 1, 6, 4)).toBe(0);
  });

  it('自由落体结束后双腿完整恢复地面姿态', () => {
    const character = new Character('空降姿态测试', false, 0x335577);
    character.airPose = 'fall';
    character.airSteerRight = 1;
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, false);

    expect(Math.abs(character.parts.legL.rotation.z)).toBeGreaterThan(0.1);
    expect(Math.abs(character.parts.legR.rotation.z)).toBeGreaterThan(0.1);

    character.airPose = 'canopy';
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, false);
    character.airPose = null;
    character.grounded = true;
    character.speed2d = 0;
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, false);

    expect(character.parts.legL.rotation.x).toBeCloseTo(0, 5);
    expect(character.parts.legL.rotation.y).toBeCloseTo(0, 5);
    expect(character.parts.legL.rotation.z).toBeCloseTo(0, 5);
    expect(character.parts.legR.rotation.x).toBeCloseTo(0, 5);
    expect(character.parts.legR.rotation.y).toBeCloseTo(0, 5);
    expect(character.parts.legR.rotation.z).toBeCloseTo(0, 5);
  });

  it('移动中执行短交互只覆盖上半身且结束后完整复位', () => {
    const character = new Character('交互姿态测试', false, 0x335577);
    character.speed2d = 4.5;
    character.beginAction('interact', 0.32);
    character.syncModel(0.1, true);

    expect(Math.abs(character.parts.legL.rotation.x)).toBeGreaterThan(0.2);
    expect(character.parts.armR.position.z).toBeGreaterThan(0.1);

    for (let i = 0; i < 45; i++) character.syncModel(1 / 60, false);
    expect(character.actionPose).toBeNull();
    expect(character.parts.armR.position.z).toBeCloseTo(0, 5);
    expect(character.parts.inner.rotation.y).toBeCloseTo(0, 5);
  });

  it('拾取和救援期间收起武器并在动作退出后恢复', () => {
    const character = new Character('持枪交互测试', false, 0x335577);
    character.guns[0] = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };
    character.curSlot = 0;
    character.syncModel(0.2, false);
    expect(character.parts.held).not.toBeNull();

    character.beginAction('pickup', 0.45);
    character.syncModel(0.2, false);
    expect(character.parts.held).toBeNull();
    expect(character.parts.inner.rotation.x).toBeGreaterThan(0.3);

    character.cancelAction();
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, false);
    expect(character.parts.held).not.toBeNull();

    const target = new Character('倒地目标', false, 0x557733);
    character.reviveTarget = target;
    character.syncModel(0.2, false);
    expect(character.parts.held).toBeNull();
    expect(character.parts.inner.position.y).toBeLessThan(-0.3);
    character.reviveTarget = null;
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, false);
    expect(character.parts.held).not.toBeNull();
    expect(character.parts.inner.position.y).toBeCloseTo(0, 5);
  });

  it('换弹动作驱动双手和弹匣且结束后手臂回到持枪姿态', () => {
    const character = new Character('换弹姿态测试', false, 0x335577);
    character.guns[0] = { def: WEAPONS.rifle, mag: 10, att: emptyAttachments() };
    character.curSlot = 0;
    character.reload01 = 0.5;
    character.syncModel(1 / 60, false);

    expect(character.parts.held?.mag?.visible).toBe(false);
    expect(character.parts.armL.rotation.x).toBeLessThan(-2);
    expect(character.parts.armL.position.z).toBeGreaterThan(0.1);

    character.reload01 = 0;
    character.syncModel(1 / 60, false);
    expect(character.parts.held?.mag?.visible).toBe(true);
    expect(character.parts.armL.position.z).toBeCloseTo(0, 5);
  });

  it('加速游泳保持明显划臂且双腿不会竖直抽动', () => {
    const character = new Character('游泳姿态测试', false, 0x335577);
    character.swimming = true;
    character.speed2d = 4.8;
    let maxLeg = 0;
    let minArm = Infinity;
    let maxArm = -Infinity;
    for (let i = 0; i < 180; i++) {
      character.swimT = i / 60 * 1.8;
      character.syncModel(1 / 60, true);
      maxLeg = Math.max(
        maxLeg,
        Math.abs(character.parts.legL.rotation.x),
        Math.abs(character.parts.legR.rotation.x),
      );
      minArm = Math.min(minArm, character.parts.armL.rotation.x);
      maxArm = Math.max(maxArm, character.parts.armL.rotation.x);
    }

    expect(maxLeg).toBeLessThan(0.34);
    expect(maxArm - minArm).toBeGreaterThan(1.2);
  });

  it('夜间补光高于旧基线且白天亮度保持稳定', () => {
    const day = environmentLighting(1, 1, 0, 0);
    const clearNight = environmentLighting(0, 1, 0, 0);
    const rainyNight = environmentLighting(0, 0.86, 0.76, 0.16);

    expect(day.hemiIntensity).toBeCloseTo(1.14, 5);
    expect(day.exposure).toBeCloseTo(1.08, 5);
    expect(clearNight.hemiIntensity).toBeGreaterThanOrEqual(0.85);
    expect(clearNight.exposure).toBeCloseTo(1.29, 5);
    expect(rainyNight.hemiIntensity).toBeGreaterThan(clearNight.hemiIntensity);
    expect(rainyNight.exposure).toBeGreaterThanOrEqual(clearNight.exposure);
  });

  it('性能优化不能降低核心渲染质量基线', () => {
    expect(RENDER_QUALITY).toEqual({
      antialias: true,
      maxPixelRatio: 1.5,
      shadows: true,
      baseExposure: 1.08,
      saturation: 1.06,
      contrast: 1.035,
    });
    expect(SUN_SHADOW_MAP_SIZE).toBe(2048);
  });
});
