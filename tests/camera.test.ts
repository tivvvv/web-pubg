import { describe, expect, it } from 'vitest';
import {
  advanceCameraMode, advanceShoulderBlend, cameraFovTarget, cameraModeTarget, sampleCameraShake,
  smoothCameraDistance,
} from '../src/camera';

describe('镜头过渡', () => {
  it('瞄具随 ADS 进度进入镜轴且手动第一人称始终完整进入', () => {
    expect(cameraModeTarget(false, false, 1)).toBe(0);
    expect(cameraModeTarget(false, true, 0.1)).toBe(0);
    expect(cameraModeTarget(false, true, 0.46)).toBeGreaterThan(0);
    expect(cameraModeTarget(false, true, 0.46)).toBeLessThan(1);
    expect(cameraModeTarget(false, true, 0.8)).toBe(1);
    expect(cameraModeTarget(true, false, 0)).toBe(1);
  });

  it('不同帧率下镜轴过渡结果接近', () => {
    let at60 = 0;
    let at30 = 0;
    for (let i = 0; i < 30; i++) at60 = advanceCameraMode(at60, 1, 1 / 60);
    for (let i = 0; i < 15; i++) at30 = advanceCameraMode(at30, 1, 1 / 30);
    expect(at60).toBeCloseTo(at30, 5);
    expect(at60).toBeGreaterThan(0.99);
  });

  it('遮挡时快速拉近且解除遮挡后平滑恢复', () => {
    const pulled = smoothCameraDistance(3.4, 0.8, 3.4, 1 / 60);
    const restored = smoothCameraDistance(pulled, 3.4, 3.4, 1 / 60);
    expect(pulled).toBeLessThan(2.5);
    expect(restored).toBeGreaterThan(pulled);
    expect(restored).toBeLessThan(3.4);
  });

  it('震动采样确定且幅度受控', () => {
    const a = sampleCameraShake({ x: 0, y: 0, z: 0, roll: 0 }, 1.25, 0.2);
    const b = sampleCameraShake({ x: 0, y: 0, z: 0, roll: 0 }, 1.25, 0.2);
    expect(a).toEqual(b);
    expect(Math.abs(a.x)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.y)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.z)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.roll)).toBeLessThanOrEqual(0.032);
  });

  it('换肩平滑穿过中轴且不同帧率结果接近', () => {
    let at60 = 1;
    let at30 = 1;
    for (let i = 0; i < 30; i++) at60 = advanceShoulderBlend(at60, -1, 1 / 60);
    for (let i = 0; i < 15; i++) at30 = advanceShoulderBlend(at30, -1, 1 / 30);
    expect(at60).toBeCloseTo(at30, 5);
    expect(at60).toBeLessThan(-0.99);
  });

  it('冲刺和开火仅提供受控广角反馈且瞄准缩放仍占主导', () => {
    const idle = cameraFovTarget(75, 1, 0, 0, 0, 0);
    const sprint = cameraFovTarget(75, 1, 1, 0, 0, 0);
    const fired = cameraFovTarget(75, 1, 0, 0, 1.2, 0);
    const scoped = cameraFovTarget(75, 2, 0, 0, 1.2, 1);
    expect(idle).toBe(75);
    expect(sprint).toBeCloseTo(77.8);
    expect(fired).toBeCloseTo(76.2);
    expect(scoped).toBeLessThan(38);
  });
});
