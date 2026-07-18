// 入口: 启动游戏
import './style.css';
import { Game } from './game';

const container = document.getElementById('game-container');
if (!container) throw new Error('缺少 #game-container');

new Game(container);
