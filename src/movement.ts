import { clamp, lerp } from './utils';

export interface MovementKeys {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
}

export interface MovementDirection {
  x: number;
  z: number;
  length: number;
  forward: number;
  strafe: number;
}

// 先在角色局部坐标中合并输入, 再统一归一化到世界坐标。
// 这样相反按键会准确抵消, 斜向移动也始终保持同一速度。
export function resolveMovementDirection(yaw: number, keys: MovementKeys): MovementDirection {
  const forwardAxis = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
  const strafeAxis = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const rawLength = Math.hypot(forwardAxis, strafeAxis);
  if (rawLength < 0.001) {
    return { x: 0, z: 0, length: 0, forward: 0, strafe: 0 };
  }

  const forward = forwardAxis / rawLength;
  const strafe = strafeAxis / rawLength;
  const fwdX = Math.sin(yaw);
  const fwdZ = Math.cos(yaw);
  const rightX = -fwdZ;
  const rightZ = fwdX;
  return {
    x: fwdX * forward + rightX * strafe,
    z: fwdZ * forward + rightZ * strafe,
    length: 1,
    forward,
    strafe,
  };
}

export function wadingSpeedMultiplier(depth: number): number {
  return lerp(0.84, 0.55, clamp(depth / 0.85, 0, 1));
}
