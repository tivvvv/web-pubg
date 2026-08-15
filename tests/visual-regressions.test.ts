import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  advancePoseBlend, Character, firstPersonWeaponPose, locomotionPose, meleeMotionPose, ownModelVisibility,
} from '../src/character';
import { emptyAttachments } from '../src/attachments';
import { environmentLighting, environmentSurfaceDetail, environmentVisualProfile } from '../src/environment';
import { RENDER_QUALITY } from '../src/rendering';
import { WEAPONS } from '../src/weapons';
import { SUN_SHADOW_MAP_SIZE } from '../src/world';
import { squadNameTagPresentation, weaponPickupSlot } from '../src/game';
import {
  TRANSPORT_PLANE_STANDING_BACK,
  TRANSPORT_PLANE_STANDING_EYE_HEIGHT,
} from '../src/planemodel';

describe('画面回归保护', () => {
  it('吉利服只能装备一次且具备完整的斗篷和枝叶轮廓', () => {
    const character = new Character('吉利服测试', true, 0x335577);
    expect(character.equipGhillie()).toBe(true);
    expect(character.ghillie).toBe(true);
    const suit = character.parts.body.getObjectByName('ghillie-suit');
    expect(suit).toBeDefined();
    expect(suit?.getObjectByName('ghillie-cloak')).toBeDefined();
    expect(suit?.getObjectByName('ghillie-hood')).toBeDefined();
    expect(suit?.getObjectByName('ghillie-backcloth')).toBeDefined();
    expect(suit?.children.filter((child) => child.name === 'ghillie-foliage')).toHaveLength(22);
    expect(suit?.children.filter((child) => child.name === 'ghillie-rag')).toHaveLength(7);
    expect(suit?.children.filter((child) => child.name === 'ghillie-strand')).toHaveLength(10);
    expect(character.equipGhillie()).toBe(false);
    expect(character.parts.body.children.filter((child) => child.name === 'ghillie-suit')).toHaveLength(1);
    expect(character.parts.armL.getObjectByName('ghillie-arm-wrap')).toBeDefined();
    expect(character.parts.armR.getObjectByName('ghillie-arm-wrap')).toBeDefined();
    expect(character.parts.legL.getObjectByName('ghillie-leg-wrap')).toBeDefined();
    expect(character.parts.legR.getObjectByName('ghillie-leg-wrap')).toBeDefined();
  });

  it('新角色模型采用无外露球形关节的方块人比例', () => {
    const character = new Character('角色细节测试', false, 0x335577);

    for (const name of [
      'eye-left', 'eye-right', 'brow-left', 'brow-right', 'mouth',
      'hair-cap', 'hair-back', 'jacket-chest-panel', 'jacket-chest-seam', 'jacket-back-yoke',
      'collar-left', 'collar-right', 'upper-arm-left', 'upper-arm-right',
    ]) {
      expect(character.group.getObjectByName(name), name).toBeTruthy();
    }
    expect(character.group.getObjectByName('arm-joint-left')).toBeUndefined();
    expect(character.group.getObjectByName('face-jaw')).toBeUndefined();
    expect(character.group.getObjectByName('head')?.children.length).toBeGreaterThanOrEqual(7);
    expect(character.parts.torso.geometry.type).toBe('BoxGeometry');
    expect(character.parts.head.geometry.type).toBe('BoxGeometry');
    const visibleBodyMeshes: THREE.Mesh[] = [];
    character.parts.body.traverse((object) => {
      if (object instanceof THREE.Mesh) visibleBodyMeshes.push(object);
    });
    expect(visibleBodyMeshes.every((mesh) => !['SphereGeometry', 'CapsuleGeometry'].includes(mesh.geometry.type))).toBe(true);
    expect(character.parts.armL.position.x).toBeGreaterThan(-0.3);
    expect(character.parts.armR.position.x).toBeLessThan(0.3);
    expect(character.parts.elbowL).toBeTruthy();
    expect(character.parts.kneeR).toBeTruthy();
  });

  it('步态统一驱动反相双腿, 膝盖抬升和身体重心', () => {
    const pose = locomotionPose(Math.PI / 2, 6.9, 0, 1);
    expect(pose.legL).toBeGreaterThan(0.7);
    expect(pose.legR).toBeLessThan(-0.7);
    expect(pose.kneeR).toBeGreaterThan(0.4);
    expect(pose.armSwing).toBeLessThan(-0.4);
    expect(pose.bob).toBeGreaterThan(0);
    const prone = locomotionPose(Math.PI / 2, 6.9, 2, 1);
    expect(Math.abs(prone.legL)).toBeLessThan(Math.abs(pose.legL));
  });

  it('徒手奔跑时双臂从身体两侧自然反摆', () => {
    const character = new Character('徒手跑步测试', false, 0x335577);
    character.grounded = true;
    character.speed2d = 6.9;
    for (let i = 0; i < 30; i++) character.syncModel(1 / 60, true);
    character.walkPhase = Math.PI / 2;
    character.syncModel(0, true);

    expect(character.parts.armL.rotation.x).toBeGreaterThan(-0.8);
    expect(character.parts.armR.rotation.x).toBeGreaterThan(-0.8);
    expect(character.parts.armL.rotation.x * character.parts.armR.rotation.x).toBeLessThan(0);
    expect(character.parts.armL.rotation.z).toBeCloseTo(0.12, 5);
    expect(character.parts.armR.rotation.z).toBeCloseTo(-0.12, 5);
    expect(character.parts.elbowR.rotation.x).toBeLessThan(-0.3);
    expect(Math.abs(character.parts.inner.rotation.y)).toBeGreaterThan(0.05);
  });

  it('挥拳包含蓄力, 伸展和完整回收三个连续阶段', () => {
    const start = meleeMotionPose(0);
    const windup = meleeMotionPose(0.12);
    const impact = meleeMotionPose(0.42);
    const recovery = meleeMotionPose(0.78);
    const end = meleeMotionPose(1);
    expect(start.extension).toBe(0);
    expect(windup.windup).toBeGreaterThan(0.3);
    expect(impact.extension).toBeGreaterThan(0.9);
    expect(recovery.extension).toBeGreaterThan(0);
    expect(recovery.extension).toBeLessThan(impact.extension);
    expect(end.extension).toBe(0);
    expect(end.recovery).toBe(1);

    const character = new Character('挥拳动作测试', false, 0x335577);
    character.swingT = 0.58;
    character.swingSide = 1;
    character.syncModel(0, false);
    expect(character.parts.armR.position.z).toBeGreaterThan(0.32);
    expect(character.parts.elbowR.rotation.x).toBeGreaterThan(-0.2);
    expect(character.parts.inner.rotation.y).toBeLessThan(-0.25);
    expect(character.parts.armL.rotation.x).toBeLessThan(-0.8);
  });

  it('第三把主武器替换玩家当前主武器栏位', () => {
    const guns = [
      { def: WEAPONS.rifle },
      { def: WEAPONS.akm },
      null,
    ];
    expect(weaponPickupSlot('sniper', guns, 0, true)).toBe(0);
    expect(weaponPickupSlot('smg', guns, 1, true)).toBe(1);
    expect(weaponPickupSlot('pistol', guns, 1, true)).toBe(2);
    expect(weaponPickupSlot('smg', [null, guns[1], null], 1, true)).toBe(0);
  });

  it('第一人称趴下隐藏会穿入相机的自身模型', () => {
    expect(ownModelVisibility(false, 2)).toEqual({ head: true, body: true, hands: true });
    expect(ownModelVisibility(true, 0)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1)).toEqual({ head: false, body: false, hands: true });
    expect(ownModelVisibility(true, 1.1)).toEqual({ head: false, body: false, hands: false });
    expect(ownModelVisibility(true, 2)).toEqual({ head: false, body: false, hands: false });
  });

  it('全流程只保留第一人称镜头且不存在第三人称切换入口', () => {
    const playerSource = readFileSync(join(process.cwd(), 'src/player.ts'), 'utf8');
    const inputSource = readFileSync(join(process.cwd(), 'src/input.ts'), 'utf8');
    const cameraSource = readFileSync(join(process.cwd(), 'src/camera.ts'), 'utf8');
    const gameSource = readFileSync(join(process.cwd(), 'src/game.ts'), 'utf8');
    const scenarioSource = readFileSync(join(process.cwd(), 'src/testscenario.ts'), 'utf8');

    expect(playerSource).not.toContain('setFirstPerson(false)');
    expect(playerSource).not.toContain('tppCameraPos');
    expect(playerSource).not.toContain('cameraAllowedDistance');
    expect(playerSource).not.toContain('shoulderBlend');
    expect(gameSource).not.toContain('viewFpp');
    expect(inputSource).not.toContain("'viewmode'");
    expect(inputSource).not.toContain("'shoulder'");
    expect(inputSource).not.toContain('KeyV');
    expect(inputSource).not.toContain('KeyQ');
    expect(cameraSource).not.toContain('cameraModeTarget');
    expect(cameraSource).not.toContain('smoothCameraDistance');
    expect(scenarioSource).not.toContain("'tpp'");
  });

  it('第一人称持枪模型避开准星且不会露出完整角色手臂', () => {
    const character = new Character('第一人称持枪测试', true, 0x335577);
    character.guns[0] = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };
    character.curSlot = 0;
    character.setFirstPerson(true);
    character.syncModel(1 / 60, false);

    expect(character.parts.held).toBeDefined();
    expect(character.parts.armL.visible).toBe(false);
    expect(character.parts.armR.visible).toBe(false);
    expect(character.parts.gun.visible).toBe(true);
    expect(character.parts.viewHands.visible).toBe(true);
    expect(character.parts.viewHands.getObjectByName('first-person-hand-left')).toBeDefined();
    expect(character.parts.viewHands.getObjectByName('first-person-hand-right')).toBeDefined();
    const pose = firstPersonWeaponPose('rifle', 0, false);
    expect(character.parts.gun.position.x).toBeCloseTo(pose.x);
    expect(character.parts.gun.position.y).toBeCloseTo(pose.y);
    expect(character.parts.gun.position.z).toBeCloseTo(pose.z);
    expect(character.parts.gun.rotation.y).toBeCloseTo(pose.yaw);
    expect(character.parts.held?.group.scale.x).toBeCloseTo(pose.scale);
  });

  it('不同枪型使用独立右下方构图且 ADS 不遮挡镜轴', () => {
    const pistol = firstPersonWeaponPose('pistol', 0, false);
    const lmg = firstPersonWeaponPose('lmg', 0, false);
    const rifleAds = firstPersonWeaponPose('rifle', 1, true);
    expect(pistol.scale).toBeGreaterThan(lmg.scale);
    expect(lmg.z).toBeGreaterThan(pistol.z);
    expect(pistol.x).toBeLessThan(0);
    expect(lmg.yaw).toBeGreaterThan(0);
    expect(rifleAds.x).toBeLessThan(-0.1);
    expect(rifleAds.y).toBeLessThan(1.2);
    expect(rifleAds.yaw).toBeGreaterThan(0);
    expect(Math.abs(rifleAds.roll)).toBeLessThan(Math.abs(lmg.roll));
  });

  it('运输机待跳视角站在真实机背且不叠加伪舱框', () => {
    const scenarioSource = readFileSync(join(process.cwd(), 'src/testscenario.ts'), 'utf8');
    expect(TRANSPORT_PLANE_STANDING_BACK).toBeGreaterThan(3);
    expect(TRANSPORT_PLANE_STANDING_BACK).toBeLessThan(5.5);
    expect(TRANSPORT_PLANE_STANDING_EYE_HEIGHT).toBeGreaterThan(1.3);
    expect(readFileSync(join(process.cwd(), 'src/player.ts'), 'utf8')).not.toContain('planeJumpBayView');
    expect(scenarioSource).toContain("'scenario=parachute&phase=plane'");
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

  it('多人同时开伞复用合批几何且卸伞不残留节点', () => {
    const first = new Character('开伞资源甲', false, 0x335577);
    const second = new Character('开伞资源乙', false, 0x668844);
    first.attachCanopy(0xd8843c);
    second.attachCanopy(0x9ab86a);

    expect(first.canopyGroup?.children).toHaveLength(4);
    expect(second.canopyGroup?.children).toHaveLength(4);
    const firstMeshes = first.canopyGroup!.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    const secondMeshes = second.canopyGroup!.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    expect(firstMeshes).toHaveLength(3);
    expect(secondMeshes).toHaveLength(3);
    expect(firstMeshes[0].geometry).toBe(secondMeshes[0].geometry);
    expect(firstMeshes[1].geometry).toBe(secondMeshes[1].geometry);
    expect(firstMeshes[2].geometry).toBe(secondMeshes[2].geometry);

    const firstGroup = first.canopyGroup;
    first.removeCanopy();
    expect(first.canopyGroup).toBeNull();
    expect(first.parts.inner.children).not.toContain(firstGroup);
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

  it('蹲姿双腿折叠在身体下方且不会沉入楼梯踏步', () => {
    const character = new Character('蹲姿楼梯测试', false, 0x335577);
    character.setStance('crouch');
    character.stanceF = 1;
    character.speed2d = 2.1;
    character.syncModel(1 / 60, true);
    character.group.updateMatrixWorld(true);

    const leftBoot = character.group.getObjectByName('boot-left');
    const rightBoot = character.group.getObjectByName('boot-right');
    expect(leftBoot).toBeDefined();
    expect(rightBoot).toBeDefined();
    if (!leftBoot || !rightBoot) return;
    const leftPos = leftBoot.getWorldPosition(new THREE.Vector3());
    const rightPos = rightBoot.getWorldPosition(new THREE.Vector3());
    expect(Math.max(Math.abs(leftPos.z), Math.abs(rightPos.z))).toBeLessThan(0.22);
    expect(Math.min(leftPos.y, rightPos.y)).toBeGreaterThan(-0.04);
    expect(character.parts.inner.position.y).toBeGreaterThan(-0.42);
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

    expect(day.hemiIntensity).toBeCloseTo(1.22, 5);
    expect(day.exposure).toBeCloseTo(1.14, 5);
    expect(clearNight.hemiIntensity).toBeGreaterThanOrEqual(0.85);
    expect(clearNight.exposure).toBeCloseTo(1.35, 5);
    expect(rainyNight.hemiIntensity).toBeGreaterThan(clearNight.hemiIntensity);
    expect(rainyNight.exposure).toBeGreaterThanOrEqual(clearNight.exposure);
  });

  it('天气同步驱动地表湿润, 云影和空气微尘强度', () => {
    const clearDay = environmentSurfaceDetail(0, 0, 0.18, 1);
    const rainyDay = environmentSurfaceDetail(0.76, 0.82, 0.9, 1);
    const clearNight = environmentSurfaceDetail(0, 0, 0.18, 0);

    expect(clearDay.wetness).toBe(0);
    expect(rainyDay.wetness).toBeCloseTo(0.82, 5);
    expect(rainyDay.cloudiness).toBeCloseTo(0.9, 5);
    expect(clearDay.moteOpacity).toBeGreaterThan(rainyDay.moteOpacity);
    expect(clearDay.moteOpacity).toBeGreaterThan(clearNight.moteOpacity);
    expect(rainyDay.lowMistOpacity).toBeGreaterThan(clearDay.lowMistOpacity);
    expect(clearNight.lowMistOpacity).toBeGreaterThan(clearDay.lowMistOpacity);
    expect(environmentSurfaceDetail(2, -1, 3, 2)).toEqual({
      wetness: 0.88,
      cloudiness: 1,
      moteOpacity: 0,
      lowMistOpacity: 0.113,
    });
  });

  it('材质灯光天气使用同一视觉配置并保证雨天可读性', () => {
    const clear = environmentVisualProfile({
      daylight: 1, sunHeight: 0.9, twilight: 0, light: 1, cloud: 0.18,
      rain: 0, wet: 0, storm: 0, fogNear: 185, fogFar: 690,
    });
    const rain = environmentVisualProfile({
      daylight: 0.72, sunHeight: 0.35, twilight: 0.1, light: 0.86, cloud: 0.9,
      rain: 0.76, wet: 0.82, storm: 0.16, fogNear: 110, fogFar: 485,
    });
    const dusk = environmentVisualProfile({
      daylight: 0.45, sunHeight: 0.04, twilight: 1, light: 0.8, cloud: 0.2,
      rain: 0, wet: 0, storm: 0, fogNear: 150, fogFar: 600,
    });

    expect(rain.surface.wetness).toBeCloseTo(0.82, 5);
    expect(rain.lighting.exposure).toBeGreaterThan(clear.lighting.exposure);
    expect(rain.sunIntensity).toBeLessThan(clear.sunIntensity);
    expect(rain.shadowRadius).toBeGreaterThan(clear.shadowRadius);
    expect(rain.rainOpacity).toBeGreaterThan(0.4);
    expect(rain.rainOpacity).toBeLessThanOrEqual(0.64);
    expect(rain.fogFar).toBeGreaterThan(rain.fogNear + 80);
    expect(rain.saturation).toBeGreaterThanOrEqual(0.99);
    expect(rain.contrast).toBeGreaterThanOrEqual(1.01);
    expect(dusk.warmth).toBeGreaterThan(clear.warmth);

    const snow = environmentVisualProfile({
      daylight: 0.7, sunHeight: 0.3, twilight: 0, light: 0.92, cloud: 0.82,
      rain: 0, snow: 0.82, wet: 0.3, storm: 0, fogNear: 118, fogFar: 515,
    });
    expect(snow.shadowRadius).toBeGreaterThan(clear.shadowRadius);
    expect(snow.fogFar).toBeGreaterThan(snow.fogNear + 100);
    expect(snow.lighting.exposure).toBeGreaterThanOrEqual(1.14);
  });

  it('性能优化不能降低核心渲染质量基线', () => {
    expect(RENDER_QUALITY).toEqual({
      antialias: true,
      maxPixelRatio: 1.5,
      shadows: true,
      shadowRefreshHz: 20,
      baseExposure: 1.1,
      saturation: 1.08,
      contrast: 1.02,
    });
    expect(SUN_SHADOW_MAP_SIZE).toBe(2048);
    expect(RENDER_QUALITY.shadowRefreshHz).toBeGreaterThanOrEqual(20);
  });

  it('渲染上下文丢失和单帧异常均有恢复保护', () => {
    const rendering = readFileSync(join(process.cwd(), 'src/rendering.ts'), 'utf8');
    const game = readFileSync(join(process.cwd(), 'src/game.ts'), 'utf8');
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(rendering).toContain("addEventListener('webglcontextlost'");
    expect(rendering).toContain("addEventListener('webglcontextrestored'");
    expect(rendering).toContain('event.preventDefault()');
    expect(game).toContain('frameSafely');
    expect(game).toContain('consecutiveFrameErrors');
    expect(main).toContain("addEventListener('unhandledrejection'");
  });

  it('近距离队友名牌不会贴入镜头或异常放大', () => {
    expect(squadNameTagPresentation(true, true, 1.8)).toEqual({ visible: false, scale: 0.34 });
    expect(squadNameTagPresentation(true, true, 4)).toEqual({ visible: true, scale: 0.34 });
    expect(squadNameTagPresentation(true, true, 24)).toEqual({ visible: true, scale: 1 });
    expect(squadNameTagPresentation(true, true, 60)).toEqual({ visible: false, scale: 1 });
    expect(squadNameTagPresentation(false, true, 12).visible).toBe(false);
  });

  it('低高度背包和右侧信息层保持可用且不遮挡瞄准中心', () => {
    const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8');
    expect(css).toMatch(/#killfeed\s*\{[^}]*top:\s*116px/s);
    expect(css).toMatch(/#toast\s*\{[^}]*top:\s*112px/s);
    expect(css).toMatch(/\.bp-panel\s*\{[^}]*max-height:\s*calc\(100vh - 32px\)/s);
    expect(css).toMatch(/\.bp-panel\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it('交互成功与失败都保留清晰且不同的准星反馈', () => {
    const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8');
    expect(css).toMatch(/data-confirm='pickup'[^}]*#a8f0b5/s);
    expect(css).toMatch(/data-confirm='interact'[^}]*#a8dcff/s);
    expect(css).toMatch(/data-confirm='vehicle'[^}]*#ffc085/s);
    expect(css).toMatch(/data-confirm='blocked'[^}]*#ff806f/s);
    expect(css).toMatch(/@keyframes interaction-blocked/);
  });

  it('命中标记和开火准星使用结构化图形反馈而不是文本符号', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8');
    expect(html).toMatch(/id="hitmarker"[^>]*>[\s\S]*hit-nw[\s\S]*hit-ne[\s\S]*hit-sw[\s\S]*hit-se/);
    expect(html).not.toContain('<div id="hitmarker">✕</div>');
    expect(css).toMatch(/#crosshair\.shot-pulse \.ch-line/);
    expect(css).toMatch(/@keyframes reticle-shot/);
    expect(css).toMatch(/--ui-panel:/);
    expect(css).toMatch(/#pickup-prompt\s*\{[^}]*--prompt-accent:/s);
  });

  it('天气栏提供可点击且具备无障碍状态的全局声音开关', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'src/style.css'), 'utf8');
    expect(html).toMatch(/id="sound-toggle"[^>]*aria-pressed="false"/);
    expect(html).toContain('id="sound-toggle-icon"');
    expect(css).toMatch(/#sound-toggle\s*\{[^}]*pointer-events:\s*auto/s);
    expect(css).toMatch(/#sound-toggle\[data-muted='true'\]/);
  });
});
