// 键鼠输入 + 指针锁定管理
export type Action =
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5'
  | 'reload' | 'mute' | 'pickup' | 'heal' | 'backpack' | 'viewmode' | 'crouch' | 'prone'
  | 'wheelUp' | 'wheelDown';

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
        case 'Digit1': this.onAction('slot1'); break;
        case 'Digit2': this.onAction('slot2'); break;
        case 'Digit3': this.onAction('slot3'); break;
        case 'Digit4': this.onAction('slot4'); break;
        case 'Digit5': this.onAction('slot5'); break;
        case 'KeyR': this.onAction('reload'); break;
        case 'KeyM': this.onAction('mute'); break;
        case 'KeyF': this.onAction('pickup'); break;
        case 'KeyX': this.onAction('heal'); break;
        case 'KeyV': this.onAction('viewmode'); break;
        case 'KeyC': this.onAction('crouch'); break;
        case 'KeyZ': this.onAction('prone'); break;
        case 'Tab':
        case 'KeyB': this.onAction('backpack'); break;
      }
    });
    this.listen(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    this.listen(window, 'blur', () => {
      this.keys.clear();
      this.lmb = false;
      this.rmb = false;
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
      this.onAction(e.deltaY > 0 ? 'wheelDown' : 'wheelUp');
    }, { passive: true });
    this.listen(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        this.lmb = false;
        this.rmb = false;
        this.keys.clear();
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

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
