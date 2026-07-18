// 小地图: 地形底色离屏预渲染 + 区域标注(河带/地名) + 圈/玩家/枪声红点
import { WORLD_HALF, WATER_Y, riverZAt, type World } from './world';
import type { Zone } from './zone';

const BASE_RES = 150;

// 区域锚点(与 buildings/world 布点一致)
const REGION_LABELS: { x: number; z: number; label: string }[] = [
  { x: 0, z: -200, label: '密林' },
  { x: -60, z: -20, label: '城区' },
  { x: 180, z: -40, label: '竞技场' },
  { x: -40, z: 200, label: '农场' },
  { x: -220, z: 20, label: '山地' },
  { x: 200, z: -220, label: '渔村' },
];

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
    // 河流带(蓝色, 描河道中心线)
    bctx.strokeStyle = 'rgba(70,130,190,0.85)';
    bctx.lineWidth = 2.2;
    bctx.beginPath();
    for (let px = 0; px <= BASE_RES; px += 3) {
      const x = (px / BASE_RES) * WORLD_HALF * 2 - WORLD_HALF;
      const z = riverZAt(x);
      const py = ((z + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      if (px === 0) bctx.moveTo(px, py);
      else bctx.lineTo(px, py);
    }
    bctx.stroke();
    // 区域名标注(低透明, 压在最底层)
    bctx.fillStyle = 'rgba(255,255,255,0.55)';
    bctx.font = '7px sans-serif';
    bctx.textAlign = 'center';
    for (const r of REGION_LABELS) {
      const px = ((r.x + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const py = ((r.z + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      bctx.fillText(r.label, px, py);
    }
    // 房屋地块标记(含 2m 安全边, 画内圈 footprint)
    bctx.fillStyle = 'rgba(122,110,94,0.95)';
    for (const p of world.buildings.plots) {
      const x0 = ((p.minX + 2 + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const z0 = ((p.minZ + 2 + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const w = ((p.maxX - p.minX - 4) / (WORLD_HALF * 2)) * BASE_RES;
      const d = ((p.maxZ - p.minZ - 4) / (WORLD_HALF * 2)) * BASE_RES;
      bctx.fillRect(x0, z0, Math.max(1.5, w), Math.max(1.5, d));
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
    vehicles: readonly { x: number; z: number; dead: boolean }[],
    squad: readonly { x: number; z: number }[],
  ): void {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.base, 0, 0, s, s);

    // 载具标记(深灰方块, 残骸变暗)
    for (const v of vehicles) {
      ctx.fillStyle = v.dead ? 'rgba(60,60,60,0.8)' : 'rgba(150,150,150,0.9)';
      ctx.fillRect(this.toMap(v.x) - 2, this.toMap(v.z) - 2, 4, 4);
    }
    // 队友绿点(常驻)
    ctx.fillStyle = '#52e07a';
    for (const q of squad) {
      ctx.beginPath();
      ctx.arc(this.toMap(q.x), this.toMap(q.z), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

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
