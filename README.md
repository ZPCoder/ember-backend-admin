# 余烬协议

根据《回合制卡牌对战游戏客户需求整理》实现的第一期可玩纵向切片。项目覆盖卡牌收集、30 张卡组构筑、任务奖励、抽包、AI 对战与玩家进度持久化，面向桌面与移动端浏览器。

## 已实现

- 1000 张原创卡牌及独立卡面资源，覆盖 20 个卡牌体系；每个体系 50 张卡牌并配套完整的单位、战术和武器曲线
- 卡牌搜索、体系/类型/稀有度/特质/关键词筛选、20 体系图鉴与分批加载
- 30 张卡组编辑、重复数量限制、曲线统计、合法性校验与保存
- 可完整游玩的回合制战斗：能量、每回合一次 2 费核心脉冲、出牌、选取目标、单位攻击、护盾、嘲讽、冲锋、突袭、风怒、剧毒、潜行、复生、冻结、亡语、投降与胜负结算
- 炉石式进阶战斗链：武器与英雄攻击、奥秘反制、发现、抉择、连击、过载、可交易、法术伤害、沉默、变形、临时增益、回合开始/结束触发与慢速战斗回放
- 确定性 AI 回合与可复现的随机数种子
- 每日/每周任务、重随、卡包重复保护、制作/分解、奖励轨道、赛季天梯与反刷奖励
- ChatGPT 身份识别、匿名设备档案与登录后安全绑定；本地开发时自动使用演示身份
- 好友请求、私聊、屏蔽、举报、幂等审计和服务端权威 PVP 结算
- Cloudflare D1 玩家档案、卡组、任务、开包、战绩和审计事件持久化
- 本地演示档案在 API 暂不可用时会按邮箱写入浏览器缓存，刷新不丢进度；运营台提供显式重置入口
- 卡组工坊支持保存多套卡组、切换已保存卡组与新建卡组草稿
- 响应式中文界面、键盘操作、ARIA 标签与社交分享图

网页纵向切片默认进入 AI 练习；战术对战页同时提供 PVP 房间大厅，已发布网页和 Flutter 客户端默认连接当前站点的 `wss://…/api/pvp`。手机和电脑只需打开同一网址即可通过房间码进行 1v1 同步出牌、攻击、回合和胜负结算；Ranked 队列按赛季 rating 近邻匹配并随等待时间放宽，Casual 不影响段位。生产 Worker 负责权威规则校验、隐藏信息、回合时限和断线同步。仓库也提供 `flutter_app/` 全端客户端，支持 Web、macOS、Windows、Linux、iOS、Android。

## Flutter 全端客户端

```bash
cd flutter_app
flutter pub get
flutter run -d chrome       # Web
flutter run -d macos        # macOS
flutter run                 # Android / iOS 设备
```

联机房间服务器和双客户端协议烟测见 [`flutter_app/README.md`](flutter_app/README.md)。

本地开发时可在仓库根目录运行 `dart run server/multiplayer_server.dart 8787` 做房间 UI/连接测试；完整规则联机应使用部署 Worker 的 `wss://当前站点/api/pvp`，发布网页和手机端不需要启动本地服务器。

## 技术结构

- `app/`：vinext/React 界面与游戏 API
- `lib/game/`：纯 TypeScript 卡牌目录、卡组规则与战斗引擎
- `db/`：Drizzle D1 数据模型和持久化服务
- `drizzle/`：数据库迁移
- `tests/`：战斗规则和发布产物检查
- `worker/`：Cloudflare Worker 入口

服务端写操作使用平台注入的 ChatGPT 身份头；生产环境不会接受客户端伪造的用户标识。玩家状态更新使用版本号和命令幂等键，避免重复领奖或重复结算。

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

常用命令：

- `npm test`：执行战斗引擎测试、生产构建和发布产物检查
- `npm run lint`：运行 ESLint
- `npm run build`：生成 Sites/Cloudflare Worker 发布包
- `npm run db:generate`：数据模型变化后生成 Drizzle 迁移

本地 D1 数据由 vinext 开发环境模拟；部署时绑定名为 `DB` 的 D1 数据库。
