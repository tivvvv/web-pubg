import { describe, expect, it } from 'vitest';
import {
  advanceCameraSpring, cameraFovTarget, cameraMotionTarget, sampleCameraShake,
} from '../src/camera';

describe('镜头过渡', () => {
  it('震动采样确定且幅度受控', () => {
    const a = sampleCameraShake({ x: 0, y: 0, z: 0, roll: 0 }, 1.25, 0.2);
    const b = sampleCameraShake({ x: 0, y: 0, z: 0, roll: 0 }, 1.25, 0.2);
    expect(a).toEqual(b);
    expect(Math.abs(a.x)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.y)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.z)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(a.roll)).toBeLessThanOrEqual(0.032);
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

  it('起停和侧移产生受控镜头惯性且 ADS 主动收敛', () => {
    const running = cameraMotionTarget(6.9, 1, 9, 0);
    const aiming = cameraMotionTarget(6.9, 1, 9, 1);
    expect(running.forward).toBeLessThan(0);
    expect(running.lateral).toBeLessThan(0);
    expect(running.vertical).toBeLessThan(0);
    expect(Math.abs(aiming.forward)).toBeLessThan(Math.abs(running.forward));
    expect(Math.abs(aiming.lateral)).toBeLessThan(Math.abs(running.lateral));
    expect(Math.abs(aiming.roll)).toBeLessThan(Math.abs(running.roll));
  });

  it('落地弹簧在不同帧率下稳定收敛', () => {
    const run = (dt: number, frames: number) => {
      let value = 0.14;
      let velocity = 0.42;
      for (let i = 0; i < frames; i++) {
        const next = advanceCameraSpring(value, velocity, 0, 17, 0.72, dt);
        value = next.value;
        velocity = next.velocity;
      }
      return { value, velocity };
    };
    const at60 = run(1 / 60, 60);
    const at30 = run(1 / 30, 30);
    expect(at60.value).toBeCloseTo(at30.value, 3);
    expect(Math.abs(at60.value)).toBeLessThan(0.001);
    expect(Math.abs(at60.velocity)).toBeLessThan(0.01);
  });
});
