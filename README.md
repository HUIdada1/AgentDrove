# AgentDrove

统一入口,把任务派发给本机已安装的 AI agent 客户端,池化各家付费套餐额度。

只走官方 CLI 链路:不调 API、不反代、不碰账号体系。本机装了什么客户端,AgentDrove 就调度什么。

## 支持矩阵

| 客户端 | 状态 | 说明 |
| --- | --- | --- |
| zcode | 全自动 | 检测、派发、回收全流程自动 |
| trae | 半自动 | 部分环节需人工确认 |
| qoder | 待实测 | 驱动已就绪,等待实测验证 |

## 安装

前往 [GitHub Releases](https://github.com/HUIdada1/AgentDrove/releases) 下载 `AgentDrove-Setup-<版本>.exe`,双击安装(可自定义安装目录)。应用内已支持自动更新(基于 GitHub Releases 的整包轨道与热更轨道)。

## 开发

要求:Node 22、pnpm 8。

```bash
pnpm install
pnpm build   # core -> shared -> renderer -> main(esbuild 打包)
pnpm test    # 各包 vitest
pnpm pack    # 构建链 + electron-builder 出 NSIS 安装包(packages/main/release/)
```

一键发版(递增版本、构建、出包、打 tag、发布 Release):

```bash
node scripts/release.mjs --patch          # 默认 patch,另有 --minor / --major
node scripts/release.mjs --no-upload      # 只构建不出包上传
node scripts/release.mjs --skip-bundle    # 跳过轨道 B 热更产物
```

## 环境变量

主进程启动时读取(均为可选):

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENTDROVE_ZCODE_CLI` | `E:\ZCode\resources\glm\zcode.cjs` | ZCode CLI 入口路径,探测与派发的唯一事实源 |
| `AGENTDROVE_TRAE_ROOTS` | `E:\Trae_guoji;E:\Trae` | Trae 安装根目录候选,分号分隔,逐个探测取首个命中 |
| `VITE_DEV_SERVER_URL` | — | 开发模式渲染层入口(如 `http://localhost:5183`),缺省按打包/开发 dist 查找 |

无头冒烟(不走 GUI,按终态给退出码):

```bash
pnpm --filter @agent-drove/main headless --prompt "你好" [--cwd dir] [--mode build] [--deny Bash,Write] [--resume 会话id] [--timeout ms]
```

## 目录结构

```
packages/
  core/      纯 TS 领域层(编排、驱动、注册表、健康检查)
  shared/    契约类型(主进程与渲染层共享)
  main/      Electron 主进程(esbuild 打包 dist/app.cjs;electron-builder 配置与图标在此)
  renderer/  Vue3 渲染层(vite 构建)
scripts/
  release.mjs  一键发版脚本
```

## 作者

沐辉

## License

[MIT](./LICENSE)
