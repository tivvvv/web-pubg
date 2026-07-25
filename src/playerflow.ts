export type PlayerFlowTone = 'info' | 'success' | 'warning' | 'danger';
export type PlayerDescentStage = 'plane' | 'freefall' | 'canopy' | null;

export interface PlayerFlowInput {
  descent: PlayerDescentStage;
  jumpReady: boolean;
  outsideZone: boolean;
  knocked: boolean;
  hasGun: boolean;
  hp: number;
  healCount: number;
  secondsSinceLanded: number;
  secondsSinceArmed: number;
}

export interface PlayerFlowCue {
  title: string;
  detail: string;
  tone: PlayerFlowTone;
}

export function shouldCelebrateFirstGun(hadGun: boolean, armedAt: number): boolean {
  return !hadGun && armedAt < 0;
}

// 只保留当前最重要的一条行动目标，避免常驻教程和临时提示争夺注意力。
export function resolvePlayerFlowCue(input: PlayerFlowInput): PlayerFlowCue | null {
  if (input.knocked) return null;
  if (input.outsideZone && input.descent !== 'plane') {
    return { title: '立即进圈', detail: '你正在持续受到安全区伤害', tone: 'danger' };
  }
  if (input.descent === 'plane') {
    return input.jumpReady
      ? { title: '跳伞窗口已开启', detail: '按 F 离开飞机', tone: 'success' }
      : { title: '航线准备', detail: '进入安全区后开放跳伞', tone: 'info' };
  }
  if (input.descent === 'freefall') {
    return { title: '自由落体', detail: '低于 150m 可按 Space 提前开伞', tone: 'info' };
  }
  if (input.descent === 'canopy') {
    return { title: '准备着陆', detail: '观察地面并选择安全落点', tone: 'info' };
  }
  if (input.hp <= 35) {
    return input.healCount > 0
      ? { title: '生命危险', detail: '寻找掩体并按 X 使用恢复品', tone: 'danger' }
      : { title: '生命危险', detail: '缺少恢复品, 优先寻找掩体和药品', tone: 'danger' };
  }
  if (!input.hasGun) {
    return { title: '搜寻武器', detail: '靠近武器按 F 拾取', tone: 'warning' };
  }
  if (input.secondsSinceArmed >= 0 && input.secondsSinceArmed < 4.5) {
    return { title: '武装完成', detail: '检查弹药并留意安全区', tone: 'success' };
  }
  if (input.secondsSinceLanded >= 0 && input.secondsSinceLanded < 5) {
    return { title: '落地阶段', detail: '快速搜刮附近建筑', tone: 'info' };
  }
  return null;
}

export interface PlayerDeathInput {
  attackerName: string | null;
  via: string | null;
  headshot: boolean;
  selfInflicted: boolean;
}

export function playerDeathDetail(input: PlayerDeathInput): string {
  if (input.selfInflicted && input.via) return `你被自己的${input.via}淘汰`;
  if (input.attackerName) {
    if (input.via) return `${input.attackerName} 使用${input.via}将你淘汰`;
    return `${input.attackerName}${input.headshot ? '爆头' : ''}将你淘汰`;
  }
  if (input.via) return `你死于${input.via}`;
  return '你被安全区淘汰';
}
