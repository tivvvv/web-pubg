// ─────────────────────────────────────────────────────────────────────────────
// knock.ts - 击倒/救援系统(DBNO): 小队成员濒死转击倒 → 流血倒计时 → 扶起复活
// 敌方 bot 不参与(直接死亡); 全部状态在 Character 字段上, 重开新角色自动清零
// ─────────────────────────────────────────────────────────────────────────────
import type { Character } from './character';
import type { Game } from './game';

const KNOCK_HP = 30;        // 击倒血上限
const REVIVE_TIME = 8;      // 救援读条秒数
export const REVIVE_RANGE = 2.2; // 发起救援距离

export class KnockSys {
  private game: Game;

  constructor(game: Game) {
    this.game = game;
  }

  // 濒死转击倒(伤害结算在 hp<=0 且为小队成员时调用)
  knockDown(c: Character, attacker: Character | null, head: boolean): void {
    const g = this.game;
    c.knocked = true;
    c.hp = 0;
    c.knockHp = KNOCK_HP;
    c.knockCount++;
    c.bleedTime = c.knockCount === 1 ? 60 : c.knockCount === 2 ? 40 : 25;
    c.reviveT = 0;
    c.reviveTarget = null;
    c.rescuerId = 0;
    // 强制脱离载具(驾驶/乘坐)
    if (c.isPlayer) {
      if (g.playerCtl?.driving) g.forceExitVehicle(c, 0);
      if (g.healT > 0) g.cancelHeal('被击倒');
    } else {
      const mate = g.squadMates.find((m) => m.char === c);
      if (mate && mate.riding) {
        const rv = mate.riding;
        g.leaveSeat(rv, mate.seatIdx);
        mate.riding = null;
        mate.seatIdx = -1;
        c.airPose = null;
        const rx = Math.cos(rv.yaw);
        const rz = -Math.sin(rv.yaw);
        c.pos.set(rv.pos.x + rx * 2.0, 0, rv.pos.z + rz * 2.0);
        c.pos.y = g.world.groundHeight(c.pos.x, c.pos.z, rv.pos.y + 1);
      }
    }
    // 下车逻辑会复位站姿, 因此最后统一强制成击倒姿态
    c.setStance('prone');
    c.stanceF = 2;
    c.vault = null;
    c.swingT = 0;
    c.speed2d = 0;
    // 击杀播报: 击倒(橙色, 区别于淘汰)
    const ns = (x: Character): string =>
      `<span class="${x.isPlayer ? 'kf-player' : x.team === 'squad' ? 'kf-squad' : 'kf-bot'}">${x.name}</span>`;
    if (attacker) {
      g.hud.killFeed(`<span class="kf-knock">${ns(attacker)} 击倒了 ${ns(c)}${head ? '（爆头）' : ''}</span>`);
    } else {
      g.hud.killFeed(`<span class="kf-knock">${ns(c)} 被安全区击倒</span>`);
    }
    if (!c.isPlayer) g.hud.toast(`队友 ${c.name} 被击倒!`);
    g.audio.warn();
  }

  // 发起救援读条(玩家 F / 队友 AI); 读条只被救援者自己的移动/受伤打断(被救者爬行不断)
  startRevive(reviver: Character, target: Character): void {
    if (reviver.knocked || !reviver.alive || !target.knocked || !target.alive) return;
    reviver.reviveTarget = target;
    reviver.reviveT = 0;
    reviver.speed2d = 0; // 清除上一帧的移动速度, 防止误触发移动打断
    target.rescuerId = reviver.id;
  }

  // 救援者受伤中断(damageChar 钩子)
  onDamaged(c: Character): void {
    if (c.reviveTarget) {
      c.reviveTarget.rescuerId = 0;
      c.reviveTarget = null;
      c.reviveT = 0;
      if (c.isPlayer) this.game.hud.toast('救援被打断');
    }
  }

  // 流血衰减 + 救援读条推进
  update(dt: number): void {
    const g = this.game;
    for (const c of g.chars) {
      if (!c.alive) continue;
      // 流血: 线性衰减, 0 → 真死(记最近攻击者)
      if (c.knocked) {
        c.knockHp -= dt * (KNOCK_HP / c.bleedTime);
        if (c.knockHp <= 0) {
          c.knocked = false;
          g.bleedOutKill(c);
          continue;
        }
      }
      // 救援读条(仅救援者移动/倒地/目标复活或死亡打断; 被救者缓慢爬行不断条)
      if (c.reviveTarget) {
        const t = c.reviveTarget;
        if (!t.knocked || !t.alive || c.knocked || c.speed2d > 0.2) {
          t.rescuerId = 0;
          c.reviveTarget = null;
          c.reviveT = 0;
        } else {
          c.reviveT += dt;
          if (c.reviveT >= REVIVE_TIME) {
            t.knocked = false;
            t.hp = 30;
            t.knockHp = 0;
            t.rescuerId = 0;
            t.setStance('stand');
            c.reviveTarget = null;
            c.reviveT = 0;
            g.hud.toast(`${t.name} 被扶起来了`);
            if (c.isPlayer || t.isPlayer) g.audio.heal();
          }
        }
      }
    }
  }

  // 最近的倒地友军(玩家救援提示 / 队友 AI 用)
  nearestKnocked(x: number, z: number, maxD: number, exclude: Character | null = null): Character | null {
    let best: Character | null = null;
    let bestD = maxD;
    for (const c of this.game.chars) {
      if (!c.alive || !c.knocked || c.team !== 'squad' || c === exclude) continue;
      const d = Math.hypot(c.pos.x - x, c.pos.z - z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}
