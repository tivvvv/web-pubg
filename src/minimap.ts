// 小地图: 地形底色离屏预渲染 + 区域标注(河带/地名) + 圈/玩家/枪声红点
import { ROAD_PATHS, WORLD_HALF, WATER_Y, riverZAt, type World } from './world';
import type { Zone } from './zone';
import type { BombardmentMapState } from './bombardment';
import { REGIONS } from './regions';
import type { SquadOrderMapState } from './squadcommands';

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
    // 道路网与场景中实际布局一致。
    bctx.strokeStyle = 'rgba(205,181,132,0.88)';
    bctx.lineWidth = 1.25;
    bctx.lineJoin = 'round';
    bctx.lineCap = 'round';
    for (const path of ROAD_PATHS) {
      bctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const p = path[i] as readonly [number, number];
        const px = ((p[0] + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
        const py = ((p[1] + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
        if (i === 0) bctx.moveTo(px, py);
        else bctx.lineTo(px, py);
      }
      bctx.stroke();
    }
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
    // 资源区边界与正式名称，高资源区使用暖色强调。
    bctx.lineWidth = 0.7;
    for (const r of REGIONS) {
      const px = ((r.x + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const py = ((r.z + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const rr = (r.radius / (WORLD_HALF * 2)) * BASE_RES;
      bctx.strokeStyle = r.tier === 'high' ? 'rgba(230,126,83,0.42)' : r.tier === 'medium' ? 'rgba(220,190,92,0.34)' : 'rgba(175,205,158,0.25)';
      bctx.beginPath();
      bctx.arc(px, py, rr, 0, Math.PI * 2);
      bctx.stroke();
    }
    bctx.font = 'bold 6.5px sans-serif';
    bctx.textAlign = 'center';
    for (const r of REGIONS) {
      const px = ((r.x + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const py = ((r.z + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      bctx.fillStyle = r.tier === 'high' ? 'rgba(255,220,194,0.82)' : r.tier === 'medium' ? 'rgba(255,239,174,0.72)' : 'rgba(235,244,229,0.58)';
      const tier = r.tier === 'high' ? '高' : r.tier === 'medium' ? '中' : '低';
      bctx.fillText(`${r.name} ${tier}`, px, py - 3.2);
    }
    // 六区主地标使用菱形和副标签, 与资源区名称错层显示.
    bctx.font = 'bold 5.2px sans-serif';
    bctx.strokeStyle = 'rgba(44,38,31,0.92)';
    bctx.lineWidth = 0.65;
    for (const site of world.mapSites) {
      const px = ((site.resolvedX + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const py = ((site.resolvedZ + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      bctx.fillStyle = 'rgba(255,211,104,0.94)';
      bctx.beginPath();
      bctx.moveTo(px, py - 2.1);
      bctx.lineTo(px + 2.1, py);
      bctx.lineTo(px, py + 2.1);
      bctx.lineTo(px - 2.1, py);
      bctx.closePath();
      bctx.fill();
      bctx.stroke();
      bctx.fillStyle = 'rgba(255,246,211,0.82)';
      bctx.fillText(site.name, px, py + 6.2);
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
    // 新地标用高对比小圆点标出, 便于跳伞选点。
    bctx.fillStyle = 'rgba(244,214,128,0.95)';
    bctx.strokeStyle = 'rgba(65,55,42,0.95)';
    bctx.lineWidth = 0.8;
    for (const p of world.landmarks) {
      const px = ((p.x + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      const py = ((p.z + WORLD_HALF) / (WORLD_HALF * 2)) * BASE_RES;
      bctx.beginPath();
      bctx.arc(px, py, 1.8, 0, Math.PI * 2);
      bctx.fill();
      bctx.stroke();
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
    squadOrder: SquadOrderMapState | null = null,
    airdrop: { x: number; z: number } | null = null,
    bombardment: BombardmentMapState | null = null,
  ): void {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.base, 0, 0, s, s);

    // 小范围轰炸区: 半透明红面 + 红色边界, 预警阶段使用虚线
    if (bombardment) {
      const bx = this.toMap(bombardment.x);
      const bz = this.toMap(bombardment.z);
      const br = (bombardment.radius / (WORLD_HALF * 2)) * s;
      ctx.save();
      ctx.fillStyle = bombardment.state === 'active' ? 'rgba(215,38,27,0.34)' : 'rgba(205,45,32,0.2)';
      ctx.strokeStyle = bombardment.state === 'active' ? '#ff3e2e' : 'rgba(255,91,70,0.95)';
      ctx.lineWidth = bombardment.state === 'active' ? 2 : 1.5;
      if (bombardment.state === 'warning') ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.arc(bx, bz, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // 空投标记(红色菱形)
    if (airdrop) {
      const ax = this.toMap(airdrop.x);
      const az = this.toMap(airdrop.z);
      ctx.fillStyle = '#ff5a3c';
      ctx.beginPath();
      ctx.moveTo(ax, az - 4.2);
      ctx.lineTo(ax + 4.2, az);
      ctx.lineTo(ax, az + 4.2);
      ctx.lineTo(ax - 4.2, az);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

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

    // 小队指令标记: 前往为金色, 警戒为蓝色, 集火为橙红色.
    if (squadOrder) {
      const ox = this.toMap(squadOrder.x);
      const oz = this.toMap(squadOrder.z);
      const color = squadOrder.kind === 'focus' ? '#ff6847' : squadOrder.kind === 'hold' ? '#79d9ff' : '#f2c94c';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(ox, oz, 5.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox, oz - 3.5);
      ctx.lineTo(ox + 3.5, oz);
      ctx.lineTo(ox, oz + 3.5);
      ctx.lineTo(ox - 3.5, oz);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
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
