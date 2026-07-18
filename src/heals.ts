// 恢复品定义: 绷带 / 一次性医疗包 / 饮料
export type HealId = 'bandage' | 'medkit' | 'drink';

export interface HealDef {
  id: HealId;
  name: string;   // 完整名(背包/提示)
  short: string;  // 底栏紧凑名
  heal: number;   // bandage: 单次 +15; medkit: 回满; drink: 20s 总量
  cap: number;    // 可恢复到的生命上限(绷带仅 75)
  cast: number;   // 读条秒数
  max: number;    // 叠加上限
}

export const HEALS: Record<HealId, HealDef> = {
  bandage: { id: 'bandage', name: '绷带', short: '绷带', heal: 15, cap: 75, cast: 2, max: 10 },
  medkit: { id: 'medkit', name: '一次性医疗包', short: '医疗包', heal: 100, cap: 100, cast: 4, max: 3 },
  drink: { id: 'drink', name: '饮料', short: '饮料', heal: 40, cap: 100, cast: 1.5, max: 5 },
};

export const HEAL_ORDER: readonly HealId[] = ['bandage', 'medkit', 'drink'];

// 饮料 buff: 20s 共恢复 40 (2 HP/s), 再用刷新不叠加
export const DRINK_DURATION = 20;
export const DRINK_TOTAL = 40;
