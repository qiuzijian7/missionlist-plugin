# CodeBuddy History Viewer

> VS Code / CodeBuddy IDE 扩展 — 把 **当前工作区** 的 CodeBuddy 聊天历史集中到左侧活动栏，支持排序、拖拽、展开浏览、状态实时高亮、一键回跳。

![activity-bar-icon](resources/icon.svg)

---

## ✨ 主要特性

- 📋 **当前工作区聚焦**：基于 `md5(normalize(cwd))` 自动匹配 CodeBuddy 的 `history/<workspaceHash>/`，只显示与当前 VS Code 工作区相关的会话（兼容 Windows 大小写盘符）
- 🟢 **实时状态指示灯**：每 3 秒后台扫描 `index.json`，区分 `running` / `pending` / `completed` / `error` / `idle`，并对**当前活跃会话**做特殊高亮（fs running ▶ 手动声明 ▶ mtime 兜底，含启动宽限期防误判）
- 🔃 **多维排序 + 手动拖拽**：时间 / 标题 / 消息数升降序，加上自由拖拽并持久化顺序
- 💬 **就地展开聊天详情**：列出全部用户消息，每条带**真实发送时间**（来自 `requests[].startedAt`，回退到消息文件 mtime）
- ✏️ **重命名 / 🗑️ 删除**：重命名通过会话目录下 `title.txt` 写入，不污染 CodeBuddy 原始数据；删除为物理移除整个 sessionDir
- 🔁 **一键回跳**：点击会话标题，尝试通过 CodeBuddy 扩展 API / 已知命令切换到对应会话，并立即把"手动声明"写回状态监控，高亮无延迟
- 🎨 **完全跟随 VS Code 主题**：所有颜色取自 `--vscode-*` CSS 变量

---

## 📦 安装

### 从 VSIX 安装（推荐）

1. `Ctrl+Shift+X` 打开扩展面板
2. 右上角 `···` → **从 VSIX 安装…**
3. 选择 `codebuddy-history-viewer.vsix`

### 从源码

```bash
npm install
npm run compile          # tsc + 拷贝 sql-wasm
# 按 F5 启动扩展开发宿主调试，或：
npm run package          # 打包为 codebuddy-history-viewer.vsix（固定文件名）
```

---

## 🚀 使用速览

| 操作 | 方式 |
|---|---|
| 打开侧边栏 | 左侧活动栏 → CodeBuddy 历史图标 |
| 切换排序 | 顶部下拉框（含「手动排序」） |
| 重新排序 | 切到「手动排序」后长按拖拽 |
| 展开消息 | 点击列表项内容区 |
| 重命名 | 悬停项 → ✏️ |
| 删除 | 悬停项 → 🗑️（二次确认） |
| 跳回 IDE 会话 | 点击列表项标题 |
| 刷新 | 顶部 🔄 / 命令面板「刷新历史记录」 |

详细说明、状态优先级、数据路径、调试日志见 [`USAGE.md`](./USAGE.md)。

---

## 🗂️ 数据来源（只读为主）

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\<account>\CodeBuddyIDE\<uid>\history\
└── <workspaceHash>\
    ├── index.json            ← 排序记录（手动排序写入此处）
    └── <sessionDir>\
        ├── index.json        ← messages + requests[].startedAt + state
        ├── messages\<msgId>.json
        └── title.txt        ← 本插件写入的自定义标题
```

辅助：`~/.workbuddy/workbuddy.db`（sql.js 读取）—— 提供 cwd → workspaceHash 的反查映射。

> 插件对原始数据**只读**；写入仅限 `title.txt`、history 根 `index.json`（手动排序），以及删除会话时的目录移除。

---

## 🧱 项目结构

```
src/
├── extension.ts          # 入口：注册 view + 命令 + 启动状态监控
├── sidebarProvider.ts    # Webview 调度：消息收发 + 跨 IDE 切换会话
├── historyReader.ts      # 扫描 / 读取 / 重命名 / 删除 / 排序读写 / cwd 反查
├── statusMonitor.ts      # 3s 轮询：状态识别 + 当前会话决策
├── db.ts                 # workbuddy.db 访问（sql.js + sql-wasm）
└── webview/
    ├── main.js           # 列表 / 详情 / 排序 / 拖拽 / 状态灯
    └── style.css         # 跟随 VS Code 主题变量
```

---

## 🛠️ 命令

| Command ID | 标题 |
|---|---|
| `codebuddy-history.refresh` | 刷新历史记录 |
| `codebuddy-history.clear` | 清除历史记录（实际等同刷新） |

---

## 🧰 技术栈

- TypeScript / VS Code Extension API / Webview API
- `sql.js` + `sql-wasm`（读取 `workbuddy.db`）
- `fs-extra`、Node 标准库 `fs / path / os / crypto`

---

## 📜 更新日志

### v0.5.2
- 📦 打包文件名固定为 `codebuddy-history-viewer.vsix`（不再带版本号），便于覆盖式更新
- 🔧 新增 `npm run package` 一键打包脚本
- 内部版本号升至 `0.5.2`

### v0.5.1
- 🕒 展开消息卡片右上角显示**单条消息真实时间**（来自 `requests[].startedAt`，回退到消息文件 mtime）
- 🔄 当 `index.json` 内容变化时，正在展开的会话详情自动刷新

### v0.5.0
- ✨ 引入实时状态监控（5 种状态 + 当前会话高亮）
- ✨ 手动拖拽排序 + 持久化
- ✨ 重命名 / 删除会话
- ✨ 一键回跳到 CodeBuddy IDE 会话

### v0.1.0
- 🎉 初始版本：左侧活动栏入口 + 历史列表 + 刷新

---

## 📄 License

MIT

## 🤝 贡献

欢迎 Issue / PR。
