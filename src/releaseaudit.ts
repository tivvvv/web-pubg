export interface ReleaseActorSample {
  id: number;
  name: string;
  alive: boolean;
  visible: boolean;
  x: number;
  y: number;
  z: number;
  hp: number;
  healthLimit?: number;
  speed: number;
  grounded: boolean;
  swimming: boolean;
  seated: boolean;
  groundY: number;
  magazine: number | null;
  capacity: number | null;
}

export interface ReleaseCameraSample {
  x: number;
  y: number;
  z: number;
  fov: number;
  distance: number;
}

export interface ReleaseVehicleSample {
  index: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  speed: number;
}

export function auditReleaseState(
  actors: readonly ReleaseActorSample[],
  camera: ReleaseCameraSample | null,
  vehicles: readonly ReleaseVehicleSample[],
  worldHalf: number,
): string[] {
  const issues: string[] = [];
  for (const actor of actors) {
    const label = `${actor.id}:${actor.name}`;
    if (![actor.x, actor.y, actor.z, actor.hp, actor.speed].every(Number.isFinite)) {
      issues.push(`actor:${label}:non-finite`);
      continue;
    }
    if (actor.alive && actor.visible && (Math.abs(actor.x) > worldHalf + 3 || Math.abs(actor.z) > worldHalf + 3)) {
      issues.push(`actor:${label}:out-of-world`);
    }
    const healthLimit = actor.healthLimit ?? 100;
    if (actor.alive && (actor.hp < 0 || actor.hp > healthLimit + 0.01)) {
      issues.push(`actor:${label}:hp:${actor.hp.toFixed(1)}`);
    }
    if (actor.alive && actor.speed < -0.01) issues.push(`actor:${label}:negative-speed`);
    if (actor.alive && actor.speed > 65) issues.push(`actor:${label}:speed:${actor.speed.toFixed(1)}`);
    if (actor.alive && actor.visible && actor.grounded && !actor.swimming && !actor.seated &&
      Number.isFinite(actor.groundY) && Math.abs(actor.y - actor.groundY) > 0.7) {
      issues.push(`actor:${label}:ground-gap:${(actor.y - actor.groundY).toFixed(2)}`);
    }
    if (actor.magazine !== null && actor.capacity !== null &&
      (!Number.isFinite(actor.magazine) || actor.magazine < 0 || actor.magazine > actor.capacity)) {
      issues.push(`actor:${label}:magazine:${actor.magazine}/${actor.capacity}`);
    }
  }
  if (camera) {
    if (![camera.x, camera.y, camera.z, camera.fov, camera.distance].every(Number.isFinite)) {
      issues.push('camera:non-finite');
    } else {
      if (camera.fov < 12 || camera.fov > 100) issues.push(`camera:fov:${camera.fov.toFixed(1)}`);
      if (camera.distance < 0 || camera.distance > 8) issues.push(`camera:distance:${camera.distance.toFixed(2)}`);
    }
  }
  for (const vehicle of vehicles) {
    if (![vehicle.x, vehicle.y, vehicle.z, vehicle.hp, vehicle.speed].every(Number.isFinite)) {
      issues.push(`vehicle:${vehicle.index}:non-finite`);
      continue;
    }
    if (Math.abs(vehicle.x) > worldHalf + 6 || Math.abs(vehicle.z) > worldHalf + 6) {
      issues.push(`vehicle:${vehicle.index}:out-of-world`);
    }
    if (vehicle.speed < -80 || vehicle.speed > 80) issues.push(`vehicle:${vehicle.index}:speed:${vehicle.speed.toFixed(1)}`);
  }
  return issues;
}
