# L叔工作台 v0.1

一个 macOS-first、本地优先的创作者个人工作台：把桌面线索、Things、飞书、Apple Calendar、小红书内容数据、热点素材与记账备份汇总到一个像素风界面，再生成当天最多五件重点任务和一张本地“小票排程”。

> v0.1 是单用户、本机运行的 MVP。后端只监听 `127.0.0.1`，没有远程登录系统，请勿暴露到公网。

## 功能地图

| 页面 | 能力 | 外部依赖 |
|---|---|---|
| 今日 | 本地时间、定位天气、趋势、关键指标、最近笔记与今日待办 | 天气可选联网 |
| 待办 | 四源今日总览、AI 最多选 5 件、避开固定事件、本地小票排程 | Things / 飞书 / EventKit / DeepSeek 均可选 |
| 财务分析 | MoneyCats 备份的本周、本月、本年收支与分类趋势 | 本地只读数据库路径 |
| 内容表现 | 小红书账号指标、趋势、笔记表现与详情 | OpenCLI 登录态 |
| 热点雷达 | 虎嗅、36Kr 素材，精选、单篇/批量朋友圈与历史朋友圈 | 次幂数据、知识适配器可选 |
| 知识大脑 | 文档列表、检索问答与热点生成 | 独立本地知识库服务，不随仓库发布 |
| 扫描报告 | 本地目录扫描、项目簇与工作线索 | 用户明确启用桌面扫描 |
| 设置 | 连接器、隐私、AI、工作时段与权限状态 | — |

所有连接器、自动抓取和后台定时器在公开版首次安装时默认关闭。

## 30 秒安装

要求：macOS 14+，Node.js 24，npm。Apple Calendar 需要 Xcode Command Line Tools；其余连接器按需安装。

```bash
./Install.command
./Start.command
```

Finder 中也可以直接双击这两个 `.command` 文件。安装脚本会：

1. 校验 Node 24；
2. 创建权限为 `0600` 的 `backend/.env.local`；
3. 安装锁定依赖；
4. 构建前端并校验后端 TypeScript；
5. 在 Swift 工具链可用时构建本机 Calendar helper；失败只会让该连接器降级，不阻断核心界面。

启动后访问 [http://127.0.0.1:3456](http://127.0.0.1:3456)。停止前台进程可按 `Ctrl+C`，或运行：

```bash
./scripts/stop.sh
```

CI 或无界面环境可用 `OPEN_BROWSER=0 ./scripts/start.sh` 禁止自动打开浏览器。

## 首次配置

默认 `.env.local` 使用虚构演示账号、关闭定时器且不包含凭证。按需编辑：

```bash
cp backend/.env.example backend/.env.local
chmod 600 backend/.env.local
```

关键变量：

| 变量 | 用途 |
|---|---|
| `XHS_ACCOUNT_KEY`, `XHS_DISPLAY_NAME` | 目标小红书账号隔离与展示 |
| `OPENCLI_BIN` | OpenCLI 可执行文件，默认 `opencli` |
| `LARK_CLI_BIN` | 飞书 CLI 可执行文件，默认 `lark-cli` |
| `WORKBENCH_SCAN_ROOT` | 用户明确授权的扫描目录 |
| `DEEPSEEK_API_KEY` | AI 行动分析和今日规划 |
| `CIMIDATA_APP_ID`, `CIMIDATA_APP_SECRET` | 热点数据 |
| `MONEYCATS_DB_PATH`, `MONEYCATS_ALLOWED_ROOT` | MoneyCats 备份与安全允许根目录 |
| `KNOWLEDGE_BASE_URL` | 独立本地知识库适配器 |
| `DISABLE_SCHEDULERS` | `1` 表示关闭后台定时器；公开版默认关闭 |

完整模板见 `backend/.env.example`。填好配置后，仍需在“设置”页逐项开启连接器。

## 可选连接器

### Things

需要 Things 3 和 macOS Automation 权限。公开版只读 Things“今天”，不会修改 Things。

### Apple Calendar

执行安装后在设置页连接 Calendar，并在“系统设置 → 隐私与安全性 → 日历”授予 helper 完全访问。排程默认只保存本地草稿，外部写入保持关闭。

### 飞书

安装并登录本机 `lark-cli`。工作台读取范围与当前用户授权和 allowlist 一致；聊天正文不会直接铺成待办，而是先经过本地裁剪和可选 AI 行动判断。

### 小红书 / OpenCLI

安装 OpenCLI，完成本地浏览器登录，再配置目标账号 ID。账号不匹配时同步会拒绝写入，避免串号。

### MoneyCats

财务分析直接解析本地备份，不使用 AI。只有配置数据库路径并手动同步时才读取；原始数据库不会复制进仓库。

配置两个路径后，可显式安装每天 10:00 的本地 LaunchAgent：

```bash
./scripts/install-finance-agent.sh
# 移除自动任务
./scripts/uninstall-finance-agent.sh
```

### 知识大脑

知识服务和内容库是独立可选适配器。本仓库不包含任何私人知识库代码、密钥或数据；未配置时页面诚实显示离线。

## 诊断

```bash
./scripts/doctor.sh
```

诊断只报告依赖和配置的“存在/不存在”，不会回显 token、聊天、日历、财务数据或绝对文件路径。

## 开发

```bash
cd backend && npm ci && npm run dev
# 另开终端
cd frontend && npm ci && npm run dev
```

测试与构建：

```bash
cd backend && npm test && npm run build
cd ../frontend && npm test && npm run build
```

## 隐私发布门槛

公开包是从文件白名单构建的，不是当前私人工作目录的整体压缩。发布前在未安装依赖、未生成构建物的干净树中运行：

```bash
./scripts/privacy-check.sh
```

它会阻止 `.env.local`、SQLite、备份、日志、`node_modules`、`dist`、个人用户名、已知账号 ID 与明显 API key 进入发行树。更多边界见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

## 已知限制

- 完整功能只支持 macOS；Linux CI 只验证非原生核心代码。
- v0.1 没有远程访问、多人协作或云部署安全模型。
- 飞书和 OpenCLI 的可读范围受各自登录态、CLI 版本和平台权限影响。
- AI 行动项仍需要用户复核，尤其是语义重复与含糊承诺。
- 知识大脑外部服务不随开源包发布。
- 没有自动数据保留策略；停止服务后删除 `backend/data` 可清空本地运行数据。

## 版本与复盘

- [v0.1 深度复盘](docs/REVIEW-v0.1.md)
- [变更记录](CHANGELOG.md)
- [设计规范](DESIGN.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

## License

代码以 [MIT License](LICENSE) 发布。字体、图标等第三方资源沿用其各自许可证。
