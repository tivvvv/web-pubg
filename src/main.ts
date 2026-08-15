// 入口: 启动游戏
import './style.css';
import { parseRandomSeed, setRandomSeed } from './random';

const bootStartedAt = performance.now();
let activeGame: { dispose(): void } | null = null;

function runtimeIssue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return typeof value === 'string' ? value : String(value);
}

// 记录未捕获异常和 Promise 拒绝, 让发布验收可以捕获此前表现为突然停帧的隐性故障。
window.addEventListener('error', (event) => {
  document.body.dataset.runtimeIssue = `uncaught:${runtimeIssue(event.error ?? event.message)}`.slice(0, 240);
});
window.addEventListener('unhandledrejection', (event) => {
  document.body.dataset.runtimeIssue = `rejection:${runtimeIssue(event.reason)}`.slice(0, 240);
});

async function bootstrap(): Promise<void> {
  const testMode = new URLSearchParams(window.location.search).get('test') === '1';
  setRandomSeed(parseRandomSeed(window.location.search, testMode ? 1337 : null));
  const container = document.getElementById('game-container');
  if (!container) throw new Error('缺少 #game-container');
  const { Game } = await import('./game');
  const testScenario = testMode ? await import('./testscenario') : null;
  const game = new Game(container);
  activeGame = game;
  testScenario?.applyTestScenarioFromUrl(game);
  document.body.dataset.bootMs = (performance.now() - bootStartedAt).toFixed(1);
  document.body.classList.add('app-ready');
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeGame?.dispose();
    activeGame = null;
  });
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  document.body.dataset.runtimeIssue = `boot:${runtimeIssue(error)}`.slice(0, 240);
  document.body.classList.add('app-ready');
  const message = document.createElement('div');
  message.className = 'boot-error';
  message.textContent = '游戏加载失败, 请刷新页面重试.';
  document.body.appendChild(message);
});
