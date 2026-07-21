// 入口: 启动游戏
import './style.css';

const bootStartedAt = performance.now();

async function bootstrap(): Promise<void> {
  const container = document.getElementById('game-container');
  if (!container) throw new Error('缺少 #game-container');
  const { Game } = await import('./game');
  const game = new Game(container);
  if (new URLSearchParams(window.location.search).get('test') === '1') {
    const { applyTestScenarioFromUrl } = await import('./testscenario');
    applyTestScenarioFromUrl(game);
  }
  document.body.dataset.bootMs = (performance.now() - bootStartedAt).toFixed(1);
  document.body.classList.add('app-ready');
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  document.body.classList.add('app-ready');
  const message = document.createElement('div');
  message.className = 'boot-error';
  message.textContent = '游戏加载失败, 请刷新页面重试.';
  document.body.appendChild(message);
});
