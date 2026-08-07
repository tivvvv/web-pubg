import { describe, expect, it } from 'vitest';
import { updateSwimFireLatch } from '../src/player';

describe('玩家游泳开火锁', () => {
  it('水中按住开火时离水后必须先松开再允许开火', () => {
    let latched = updateSwimFireLatch(false, true, true);
    expect(latched).toBe(true);

    latched = updateSwimFireLatch(latched, false, true);
    expect(latched).toBe(true);

    latched = updateSwimFireLatch(latched, false, false);
    expect(latched).toBe(false);
  });

  it('未按开火键进入水中不会产生锁定或补发', () => {
    expect(updateSwimFireLatch(false, true, false)).toBe(false);
  });
});
