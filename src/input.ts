// 键鼠输入 + 指针锁定管理
export type Action =
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5'
  | 'reload' | 'mute' | 'pickup' | 'heal' | 'backpack' | 'fireMode' | 'crouch' | 'prone'
  | 'wheelUp' | 'wheelDown' | 'squadContext' | 'squadHold' | 'squadFollow';

const ACTION_QUEUE_CAPACITY = 16;
const ACTIONS_PER_FRAME = 4;

function actionFamily(action: Action): string | null {
  if (action.startsWith('slot')) return 'slot';
  if (action === 'crouch' || action === 'prone') return 'stance';
  if (action === 'wheelUp' || action === 'wheelDown') return 'wheel';
  if (action === 'squadContext' || action === 'squadHold' || action === 'squadFollow') return 'squad';
  return null;
}

/**
 * 将离散操作从浏览器事件回调隔离到游戏帧中处理。
 * 同一帧的重复键和互斥操作只保留最新一次，并设置硬上限，避免组合键风暴造成重入状态切换。
 */
export class ActionQueue {
  private readonly pending: Action[] = [];

  enqueue(action: Action): void {
    const family = actionFamily(action);
    const existing = this.pending.findIndex((queued) => (
      queued === action || (family !== null && actionFamily(queued) === family)
    ));
    if (existing >= 0) this.pending.splice(existing, 1);
    if (this.pending.length >= ACTION_QUEUE_CAPACITY) this.pending.shift();
    this.pending.push(action);
  }

  flush(dispatch: (action: Action) => void, limit = ACTIONS_PER_FRAME): number {
    let count = 0;
    while (count < limit && this.pending.length > 0) {
      const action = this.pending.shift() as Action;
      dispatch(action);
      count++;
    }
    return count;
  }

  clear(): void {
    this.pending.length = 0;
  }

  get size(): number {
    return this.pending.length;
  }
}

export class Input {
  keys = new Set<string>();
  lmb = false;
  rmb = false;
  firePressed = false; // 左键按下沿(半自动用), 每帧消费
  dx = 0;              // 本帧鼠标累计位移
  dy = 0;
  locked = false;

  private el: HTMLElement;
  private onAction: (a: Action) => void;
  private onLockChange: (locked: boolean) => void;
  private readonly actionQueue = new ActionQueue();
  private disposers: (() => void)[] = [];
  // ?test 模式: 无指针锁定(自动化测试/调试)
  readonly testMode = new URLSearchParams(window.location.search).has('test');

  constructor(el: HTMLElement, onAction: (a: Action) => void, onLockChange: (locked: boolean) => void) {
    this.el = el;
    this.onAction = onAction;
    this.onLockChange = onLockChange;
    this.attach();
  }

  private listen<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type as string, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type as string, fn as EventListener, opts));
  }

  private attach(): void {
    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'Digit1': this.actionQueue.enqueue('slot1'); break;
        case 'Digit2': this.actionQueue.enqueue('slot2'); break;
        case 'Digit3': this.actionQueue.enqueue('slot3'); break;
        case 'Digit4': this.actionQueue.enqueue('slot4'); break;
        case 'Digit5': this.actionQueue.enqueue('slot5'); break;
        case 'KeyR': this.actionQueue.enqueue('reload'); break;
        case 'KeyB': this.actionQueue.enqueue('fireMode'); break;
        case 'KeyM': this.actionQueue.enqueue('mute'); break;
        case 'KeyF': this.actionQueue.enqueue('pickup'); break;
        case 'KeyX': this.actionQueue.enqueue('heal'); break;
        case 'KeyC': this.actionQueue.enqueue('crouch'); break;
        case 'KeyZ': this.actionQueue.enqueue('prone'); break;
        case 'KeyG': this.actionQueue.enqueue('squadContext'); break;
        case 'KeyH': this.actionQueue.enqueue('squadHold'); break;
        case 'KeyJ': this.actionQueue.enqueue('squadFollow'); break;
        case 'Tab': this.actionQueue.enqueue('backpack'); break;
      }
    });
    this.listen(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    this.listen(window, 'blur', () => {
      this.keys.clear();
      this.lmb = false;
      this.rmb = false;
      this.actionQueue.clear();
    });
    this.listen(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked && !this.testMode) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    this.listen(document, 'mousedown', (e: MouseEvent) => {
      if (!this.locked && !this.testMode) return;
      if (e.button === 0) {
        this.lmb = true;
        this.firePressed = true;
      } else if (e.button === 1) {
        e.preventDefault();
        this.actionQueue.enqueue('squadContext');
      } else if (e.button === 2) {
        this.rmb = true;
      }
    });
    this.listen(document, 'mouseup', (e: MouseEvent) => {
      if (e.button === 0) this.lmb = false;
      else if (e.button === 2) this.rmb = false;
    });
    this.listen(document, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(document, 'wheel', (e: WheelEvent) => {
      if (!this.locked && !this.testMode) return;
      this.actionQueue.enqueue(e.deltaY > 0 ? 'wheelDown' : 'wheelUp');
    }, { passive: true });
    this.listen(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        this.lmb = false;
        this.rmb = false;
        this.keys.clear();
        this.actionQueue.clear();
      }
      this.onLockChange(this.locked);
    });
    this.listen(document, 'pointerlockerror', () => this.onLockChange(false));
  }

  requestLock(): void {
    if (this.locked || this.testMode) return;
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => this.onLockChange(false));
    } catch {
      this.onLockChange(false);
    }
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }

  consumeFirePressed(): boolean {
    const v = this.firePressed;
    this.firePressed = false;
    return v;
  }

  flushActions(): number {
    return this.actionQueue.flush(this.onAction);
  }

  clearActions(): void {
    this.actionQueue.clear();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.actionQueue.clear();
  }
}
