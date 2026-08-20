import { describe, expect, it, vi } from 'vitest';
import { ActionQueue, type Action } from '../src/input';

describe('组合键输入队列', () => {
  it('同类操作只保留最新一次并在帧边界串行派发', () => {
    const queue = new ActionQueue();
    queue.enqueue('slot1');
    queue.enqueue('slot2');
    queue.enqueue('crouch');
    queue.enqueue('prone');
    queue.enqueue('reload');
    const actions: Action[] = [];

    expect(queue.flush((action) => actions.push(action))).toBe(3);
    expect(actions).toEqual(['slot2', 'prone', 'reload']);
    expect(queue.size).toBe(0);
  });

  it('大量组合键有硬上限且每帧限制派发数量', () => {
    const queue = new ActionQueue();
    const burst: Action[] = [
      'reload', 'mute', 'pickup', 'heal', 'backpack', 'fireMode', 'slot1', 'slot2',
      'crouch', 'prone', 'wheelUp', 'wheelDown', 'squadContext', 'squadHold', 'squadFollow',
    ];
    for (let repeat = 0; repeat < 80; repeat++) {
      for (const action of burst) queue.enqueue(action);
    }

    expect(queue.size).toBeLessThanOrEqual(16);
    const dispatch = vi.fn();
    expect(queue.flush(dispatch)).toBe(4);
    expect(dispatch).toHaveBeenCalledTimes(4);
    queue.clear();
    expect(queue.size).toBe(0);
  });
});
