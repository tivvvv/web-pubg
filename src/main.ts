// 入口: 启动游戏
import './style.css';
import { Game } from './game';
import { applyTestScenarioFromUrl } from './testscenario';

const container = document.getElementById('game-container');
if (!container) throw new Error('缺少 #game-container');

const game = new Game(container);
applyTestScenarioFromUrl(game);
document.body.classList.add('app-ready');
