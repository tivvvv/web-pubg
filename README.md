# 绝地突围

基于 Three.js 和 TypeScript 的网页大逃杀原型。项目包含 24 人对局, 小队 AI, 空降, 枪械配件, 游泳, 载具, 动态天气, 轰炸区, 区域资源和多层建筑。

自动武器支持用 `B` 在单发和全自动之间切换, 模式会随当前枪械独立保留。背包统一使用 `Tab` 打开。

机器人队友会共享可见目标和受击来源, 并按左侧翼, 中央支援和右侧翼分工接敌。共享情报会随目标失效或超时自动清理。

## 拉取代码后运行游戏

运行环境需要 Git, npm, Node.js 20.19.x 或 Node.js 22.12 以上版本.

首次下载项目时执行:

```bash
git clone https://github.com/tivvvv/web-pubg.git
cd web-pubg
npm install
npm run dev
```

如果本地已经有项目, 拉取最新代码后执行:

```bash
cd web-pubg
git pull origin main
npm install
npm run dev
```

启动成功后, 打开终端显示的地址. 默认通常为 `http://localhost:5173/`. 修改源码时页面会自动刷新, 按 `Ctrl+C` 可以停止开发服务器.

需要检查代码或运行生产版本时执行:

```bash
npm test
npm run build
npm run preview
```

`npm test` 会运行自动化回归, `npm run build` 会生成生产文件到 `dist`, `npm run preview` 会在本地预览生产构建.

## 美术与音效资产

- `public/assets/textures` 保存墙面、地表、木材、金属、布料、石材、混凝土、屋瓦、植被、风化喷漆金属和磐石城砖墙十一类轻量可平铺 PNG，运行时作为程序模型的材质细节层。
- `public/assets/audio` 保存枪声、命中、爆炸、交互反馈、六类分材质脚步和区域环境声 WAV。关键反馈优先播放采样，资源未就绪时自动回退原有 WebAudio 合成音。
- 林场、海岸和开阔地拥有独立环境混音，降雨与风声会在室内自然衰减。
- 枪声会根据室内、林区和开阔地叠加不同空间尾音，集装箱、载具和户外货箱使用独立喷漆金属细节。
- `npm run assets:generate` 可确定性重建全部项目自有资产，生成脚本位于 `scripts/generate-assets.mjs`。
- 测试模式会在 `body` 数据属性发布材质加载数、音效解码数和最近播放的采样，便于真实浏览器回归。

## 固定测试场景

开发服务器运行后, 可直接打开以下地址重复验证重点系统。测试模式不会请求鼠标锁定。

- `/?test=1&scenario=stairs`: 多层建筑, 楼梯净空和墙体接缝
- `/?test=1&scenario=swim&auto=1`: 自动加速游向岸边, 检查入水姿态和连续上岸
- `/?test=1&scenario=combat`: M416, 2 倍镜, 扩容弹匣和补偿器
- `/?test=1&scenario=combat&ads=1&sight=scope4`: 检查 ADS 镜轴过渡, 真实 FOV 和镜头复位
- `/?test=1&scenario=combat&action=pickup&hold=1`: 持枪拾取动作, 也可替换为 interact/equip/heal/drink
- `/?test=1&scenario=bottactics`: 机器人交战, 恢复, 搜索和跑圈决策
- `/?test=1&scenario=botvehicle`: 机器人搜车, 驾驶转移和到点下车
- `/?test=1&scenario=botvehicle&route=bridge&contact=1`: 机器人驾车过桥并在接敌后下车
- `/?test=1&scenario=stability&seed=1337&simSteps=12&rounds=2`: 固定种子长局, 卡住监控和重开资源校验
- `/?test=1&scenario=parachute`: 玩家与队友同步自由落体和开伞
- `/?test=1&scenario=vehicle&drive=1`: 载具环视, 自动回正, 驾驶碰撞和仪表
- `/?test=1&scenario=deathcrate`: F 目标确认, 死亡盒搜索, 自动装备和负重
- `/?test=1&scenario=stairs&view=entrance`: 门交互目标, 开合动作和室内防穿镜头
- `/?test=1&scenario=stairs&slice=1&view=facade`: 磐石城双层样板楼固定立面机位
- `/?test=1&scenario=stairs&slice=1&view=interior`: 磐石城双层样板楼固定室内机位
- `/?test=1&scenario=bombardment`: 轰炸区预警, 追加 `&phase=active` 检查落弹
- `/?test=1&scenario=revive&auto=1`: 自动救援倒地队友, 检查读条动作和恢复站姿
- `/?test=1&scenario=zone`: 圈外持续伤害和进圈后停止伤害
- `/?test=1&scenario=endgame`: 最后一名敌人淘汰和胜利结算
- `/?test=1&scenario=defeat`: 玩家淘汰, 失败结算和重新开始
- `/?test=1&scenario=maptour&region=stonegate`: 地图主地标, 区域资源和转移路线巡查

普通对局仍使用 `/` 进入。

测试模式保留键鼠控制但不请求浏览器锁定鼠标。给枪战场景追加 `&ads=1` 可在打开页面后保持 ADS, 用于直接检查瞄具和 FOV。追加 `&sight=reddot` 或 `&sight=scope4` 可切换红点和 4 倍镜, 默认使用 2 倍镜。

枪战场景还支持 `&weapon=akm`, `lmg`, `smg`, `dmr`, `sniper`, `shotgun` 或 `pistol` 切换武器, 并可用 `&muzzle=suppressor` 或 `&muzzle=none` 验收消音器和裸枪表现。追加 `&mag=1` 可从一发弹药开始验证空仓自动换弹, `&burst=5` 会自动完成五发受控连射。未指定时仍使用带扩容弹匣和补偿器的 M416。

武器与战术装备扩充加入 M249 轻机枪和闪光弹。M249 使用步枪弹, 拥有 50 发弹盒和持续压制定位, 可装瞄具、枪口和扩容弹匣; 闪光弹会按照距离、人物朝向和建筑遮挡计算致盲时间, 并短暂限制移动与攻击, 老练机器人也会在中近距离主动使用。按 `5` 可在已有的手雷、烟雾弹和闪光弹之间循环。

对局变化 3.0 会在每局随机选择均衡战局、军械争夺、救援前线或火线转移。规则会联动三个区域事件的资源主题、首轮空投时间、后续空投间隔和轰炸区冷却, 开局提示会明确本局规则, 同一张地图因此形成不同的争夺路线和中期压力。

地图内六个正式区域均配置了可连续转移的硬掩体路线。路线节点间距控制在一次短冲刺范围内, 并按城区路障, 竞技场集装箱, 农场草垛, 林场原木, 山脊胸墙和渔港货箱形成不同交战节奏。

每局会在三个不同地标生成军械缓存, 医疗补给和配件工坊动态事件。事件会改变实际掉落组合, 同步标记在小地图并在进入事件范围后显示区域说明。

六区分别拥有旧城集市, 冠军货场, 丰收粮站, 北境木场, 鹰眼电台和海风鱼市主地标. 主地标会同步显示在 HUD 和小地图, 周边拥有稳定室外补给点. 北境林场公路和南部跨河道路补齐了六区之间的宏观转移网络.

地图与建筑美术 3.0 为六区建立独立墙面, 屋顶和装饰色体系. 城区檐线, 竞技场工业吊架, 农场风向标, 林场锯木门架, 山脊天线阵列和渔港入口横牌共同强化区域轮廓, 新增装饰构件不会改变门窗净空或导航碰撞.

发布级美术垂直切片首先覆盖磐石城旧城集市和最近的双层住宅. 集市新增贴合地形的连续石铺地, 分段路肩, 排水沟, 砖门柱, 摊位货物, 路灯, 架空线, 长凳, 花池和手推车. 样板楼新增专属砖墙, 暖灰抹灰, 门廊, 雨棚, 花箱, 线路, 屋顶设备, 室内木作, 厨房, 卧室和双层暖光. 完整标准见 `docs/ART_DIRECTION.md`.

## 性能架构

- 启动入口, 正式游戏和测试场景按需拆包, 普通对局不会加载测试场景代码.
- 角色落地, 移动碰撞, AI 视线和子弹静态命中使用二维空间网格缩小候选范围, 最终判定仍使用原有精确算法.
- HUD 只在显示值变化时写入 DOM, 避免稳定画面下重复触发布局与样式更新.
- 抗锯齿, 1.5 最大像素比, 实时阴影和 2048 太阳阴影贴图作为自动回归保护项, 性能优化不得降低这些画质基线.
- 固定测试场景会在 `body` 数据属性暴露 FPS, 帧耗时, draw calls, 三角形和资源数量, 便于浏览器验收.
