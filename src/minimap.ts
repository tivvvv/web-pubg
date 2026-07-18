// 小地图: 地形底色离屏预渲染 + 圈/玩家/枪声红点
import { WORLD_HALF, WATER_Y, type World } from './world';
import type { Zone } from './zone';

const BASE_RES = 150;

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  size: number;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.size = canvas.width;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.base = document.createElement('canvas');
    this.base.width = BASE_RES;
    this.base.height = BASE_RES;
    const bctx = this.base.getContext('2d') as CanvasRenderingContext2D;
    const img = bctx.createImageData(BASE_RES, BASE_RES);
    for (let py = 0; py < BASE_RES; py++) {
      for (let px = 0; px < BASE_RES; px++) {
        const x = (px / BASE_RES) * WORLD_HALF * 2 - WORLD_HALF;
        const z = (py / BASE_RES) * WORLD_HALF * 2 - WORLD_HALF;
        const h = world.getHeight(x, z);
        let r: number, g: number, b: number;
        if (h < WATER_Y - 0.2) {
          r = 42; g = 84; b = 112;
        } else if (h < WATER_Y + 0.65) {
          r = 186; g = 168; b = 122;
        } else if (h > 12) {
          r = 122; g = 122; b = 116;
        } else {
          r = 92; g = 132; b = 70;
        }
        const i = (py * BASE_RES + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    // 建筑群标记
    bctx.fillStyle = 'rgba(120,116,108,0.9)';
    for (const c of world.compounds) {
      const s = (c.half * 2 / (WORLD_HALF * 2)) * BASE_RES;
      bctx.fillRect(
        ((c.x - c.half + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES,
        ((c.z - c.half + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES,
        s, s,
      );
    }
  }

  private toMap(x: number): number {
    return ((x + WORLD_HALF) / (WORLD_HALF * 2)) * this.size;
  }

  draw(
    zone: Zone,
    px: number, pz: number, yaw: number,
    recentShots: readonly { x: number; z: number }[],
    shotCount: number,
  ): void {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.base, 0, 0, s, s);

    // 下一个圈(蓝)
    ctx.strokeStyle = 'rgba(80,150,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(this.toMap(zone.nextCenter.x), this.toMap(zone.nextCenter.y), (zone.nextRadius / (WORLD_HALF * 2)) * s, 0, Math.PI * 2);
    ctx.stroke();
    // 当前圈(白)
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.toMap(zone.center.x), this.toMap(zone.center.y), (zone.radius / (WORLD_HALF * 2)) * s, 0, Math.PI * 2);
    ctx.stroke();

    // 开枪暴露的敌人红点
    ctx.fillStyle = '#ff4444';
    for (let i = 0; i < shotCount; i++) {
      const p = recentShots[i] as { x: number; z: number };
      ctx.beginPath();
      ctx.arc(this.toMap(p.x), this.toMap(p.z), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 玩家箭头(带朝向)
    const cx = this.toMap(px);
    const cy = this.toMap(pz);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI - yaw); // 世界前方(sin yaw, cos yaw), 地图 +z 向下
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.2, 5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-4.2, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
