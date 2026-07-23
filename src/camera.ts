import { clamp, lerp, smoothstep } from './utils';

export interface CameraShakeSample {
  x: number;
  y: number;
  z: number;
  roll: number;
}

// 手动第一人称直接请求完整镜轴, 瞄具则随 ADS 进度提前平滑进入镜轴。
export function cameraModeTarget(manualFpp: boolean, optic: boolean, aimProgress: number): number {
  if (manualFpp) return 1;
  if (!optic) return 0;
  return smoothstep(0.18, 0.74, aimProgress);
}

export function advanceCameraMode(current: number, target: number, dt: number): number {
  const rate = target > current ? 17 : 20;
  const next = lerp(current, target, 1 - Math.exp(-rate * Math.max(0, dt)));
  if (Math.abs(next - target) < 0.0005) return target;
  return clamp(next, 0, 1);
}

// 遮挡时快速收近, 遮挡解除后缓慢放远, 避免墙角和楼梯处来回弹镜头。
export function smoothCameraDistance(
  current: number,
  allowed: number,
  desired: number,
  dt: number,
): number {
  const target = clamp(Math.min(allowed, desired), 0.25, Math.max(0.25, desired));
  const rate = target < current ? 30 : 8.5;
  const next = lerp(current, target, 1 - Math.exp(-rate * Math.max(0, dt)));
  return Math.abs(next - target) < 0.001 ? target : next;
}

// 使用连续波形代替逐帧随机抖动, 保留爆炸冲击感但不制造高频闪烁。
export function sampleCameraShake(out: CameraShakeSample, time: number, amplitude: number): CameraShakeSample {
  const a = Math.max(0, amplitude);
  out.x = (Math.sin(time * 31.7) * 0.68 + Math.sin(time * 17.3 + 1.2) * 0.32) * a;
  out.y = (Math.sin(time * 27.1 + 0.7) * 0.72 + Math.sin(time * 13.9) * 0.28) * a;
  out.z = (Math.sin(time * 24.3 + 2.1) * 0.64 + Math.sin(time * 19.1 + 0.4) * 0.36) * a;
  out.roll = Math.sin(time * 21.7 + 0.35) * a * 0.16;
  return out;
}
