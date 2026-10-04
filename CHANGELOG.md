# Changelog

## v0.4.7 (2026-10-04)

5c874ac feat(core+main+renderer): 用量账本结构化(缓存命中率/点数/剩余配额)+ IPC 克隆安全防御 + 用量仪表
3d3ca62 chore(release): v0.4.6 版本同步与 CHANGELOG

## v0.4.6 (2026-10-04)

9e7253c feat(core+main+renderer): 内置技能选择与追问排队队列 + 斜杠命令/引导中心
9ea077b chore(release): v0.4.5 版本同步与 CHANGELOG

## v0.4.5 (2026-10-04)

4579a82 feat(core+main+renderer): zcode 内置 Provider 配置自动定位注入 + 任务详情弹窗化与详情栏锁起
ac95175 chore(release): v0.4.4 版本同步与 CHANGELOG

## v0.4.4 (2026-10-03)

21f87d9 fix(core+main+renderer): 双板块深度审查修复——带附件派发必炸/探活并行/CSV转义等16项
d7ee770 chore(release): v0.4.3 版本同步与 CHANGELOG

## v0.4.3 (2026-10-03)

08eb27c fix(main+renderer): 打包态 zcode 改用系统 node + 设置保存/切主题的 IPC 克隆修复
3b39616 chore(release): v0.4.2 版本同步与 CHANGELOG

## v0.4.2 (2026-10-03)

0b6e597 chore: ignore packages/main/AgentDrove(历史 electron 运行时残留副本,app.asar 被系统句柄锁定暂无法删除)
cb4fa65 fix(renderer): 设置页永停"加载设置中"+ 四栏可拖拽分隔条
369e964 fix(core+main+shared+renderer): 启动竞态致界面永久空态——装配/IPC/窗口同步段就绪,探测后台化补 agents:changed 推送
6e97b38 chore(release): v0.4.1 版本同步与 CHANGELOG

## v0.4.1 (2026-10-03)

0419deb fix(core+main+renderer): 深度自查八项修复——派发TDZ必崩清零/IME组词守卫/重扫注销失效客户端/托盘防御/最大化初始态
e136775 chore(release): v0.4.0 版本同步与 CHANGELOG

## v0.4.0 (2026-10-03)

69e0d82 fix(core+main+renderer): 五板块深度审查修复——4高危·40中危清零,补168测试与发布链
a83de0c chore(release): v0.3.0 版本同步与 CHANGELOG

## v0.2.0 (2026-10-02)

2997f8c feat(ui): 翡翠绿细磨砂玻璃改版 v0.2.0——设计令牌重铸(翡翠绿accent/底色提亮/26px模糊+双内缘折射光+斜向光泽)、渐变网格+双光斑底景+细噪点、卡片聚光(vSpotlight全局注册接任务卡与Agent卡)、auto主题实时跟随系统、chip底色令牌化与热键冲突框语义色;含全量审查修复(core任务id幂等/驱动缺失不推进节拍/main与shared配套)
40382a1 feat(ui): 液态玻璃改版——四栏布局(可收缩Agent侧栏/任务列/会话流/详情)、明暗双主题冷调青蓝、玻璃组件库(ui/)、SVG logo与应用图标重绘、浏览器端node内建垫片修复白屏
12cb21e feat(M4/M5): Electron 壳与三栏 UI——IPC 契约/主进程装配/托盘热键单实例/updater/bootstrap 校验/Vue3 面板(虚拟时间线/设置页/迷你条)/NSIS 打包链(release.mjs/图标)/批量与导出;实测产出 Setup exe
92eddc2 fix(M3): resumeLatest 全链路落库——类型/提交/SQLite 迁移 v3/驱动入参,-c 降级语义真正到达驱动
091c85f feat(M3): 唤起与续聊——deep link 表(实测协议键)+spawn 回退、续聊链(parent 链/--resume/-c 降级/running 拒绝)、health TTL 缓存(并发去重/强制绕过)
adb0e1d feat(M2): 存储与核心增强——SQLite 适配器(WAL/迁移/损坏恢复)/节流器(cap硬闸·记账返还·暂停闸·公平放行·同cwd互斥)/失败降级(候选筛选·模型映射·哨兵)/产物扫描(基线·快照diff)/工作区管理(worktree·tempcopy降级·到期清理)/事件批量缓冲(10万条压测通过)/qoder·trae 驱动
cf26469 feat(M1): core 端口化与 zcode 真实驱动——状态机收敛/启动恢复/哨兵模型/GBK 回退/进程树终止,headless 端到端打通
be5deef chore: 方案文档移出版本库,仅本地保留
6ceda14 docs: 整体方案 v6 定稿(合并 v4/v5)——GitHub 仓库与 Releases 发版、热更新双轨、作者沐辉、仅安装版
3126a6a docs: 最终方案 v5 定稿(四路调研实测+独立评审 v5.1 修订)
28aaa03 feat: AgentDrove 最终方案 v4 与核心骨架(状态机/注册表/mock 驱动,11 用例全绿)

## v0.3.0 (2026-10-02)

e3e745d feat(codex+workspace): 接入 Codex 驱动与侧栏选中工作区——CodexDriver(codex exec --json 无头/-C 工作目录/档位→沙箱映射 build·plan只读 edit可写 yolo全权/exec resume·--last 续聊/thread_id 会话锚点/login status 探活,装后自动注册)、SQLite迁移v4(projects表+tasks.project_id)、内置日常工作区(id=daily,可绑定/解绑目录,未绑定=分组态落默认工作区,禁删)、侧栏工作区区(原生目录弹窗登记项目/同目录去重/改名/移除仅解除分组)、选中后发布框目录跟随+任务列表按项目过滤(localStorage持久化选中态)、续聊/重试/换端/failover全链路透传projectId、shared契约加projects:*与dialog:pick-directory、mock与dev配套;单测141全绿(core118+main23)
cc45a5d chore(release): v0.2.0 版本同步与 CHANGELOG

