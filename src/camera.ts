import { clamp, lerp } from './utils';

export interface CameraShakeSample {
  x: number;
  y: number;
  z: number;
  roll: number;
}

export interface CameraMotionSample {
  forward: number;
  lateral: number;
  vertical: number;
  roll: number;
}

export interface CameraSpringSample {
  value: number;
  velocity: number;
}

// 起停惯性、侧移压肩和速度重心统一生成镜头目标，ADS 时主动收敛以保持瞄准稳定。
export function cameraMotionTarget(
  speed: number,
  lateralInput: number,
  acceleration: number,
  aimProgress: number,
): CameraMotionSample {
  const speedF = clamp(speed / 6.9, 0, 1);
  const lateral = clamp(lateralInput, -1, 1);
  const calm = lerp(1, 0.24, clamp(aimProgress, 0, 1));
  const scale = calm * 0.62;
  return {
    forward: clamp(-acceleration * 0.012, -0.11, 0.11) * scale,
    lateral: -lateral * 0.085 * scale,
    vertical: -speedF * 0.024 * scale,
    roll: -lateral * 0.013 * calm,
  };
}

// 固定小步长的阻尼弹簧用于落地回弹，避免不同刷新率下出现明显不同的过冲。
export function advanceCameraSpring(
  value: number,
  velocity: number,
  target: number,
  response: number,
  damping: number,
  dt: number,
): CameraSpringSample {
  const steps = Math.max(1, Math.ceil(Math.max(0, dt) * 120));
  const step = Math.max(0, dt) / steps;
  const stiffness = Math.max(0.01, response) ** 2;
  const drag = 2 * clamp(damping, 0, 2) * Math.max(0.01, response);
  for (let i = 0; i < steps; i++) {
    velocity += ((target - value) * stiffness - velocity * drag) * step;
    value += velocity * step;
  }
  return { value, velocity };
}

export function cameraFovTarget(
  baseFov: number,
  zoom: number,
  groundSprint: number,
  swimSprint: number,
  shotKick: number,
  aimProgress: number,
): number {
  const movementFov = clamp(groundSprint, 0, 1) * 2.8 + clamp(swimSprint, 0, 1) * 5;
  const kickFov = clamp(shotKick, 0, 2) * lerp(1, 0.35, clamp(aimProgress, 0, 1));
  return (baseFov + movementFov + kickFov) / Math.max(1, zoom);
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
