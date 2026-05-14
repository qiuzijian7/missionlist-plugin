# CodeBuddy History Viewer · 使用指南

一个 VS Code / CodeBuddy IDE 扩展，把 **CodeBuddy 当前工作区的聊天历史** 集中显示在左侧活动栏，支持搜索、排序、重命名、删除、拖拽排序、实时状态高亮，以及一键回到任意历史会话。

> 当前版本：**0.5.2**
> 打包产物：`codebuddy-history-viewer.vsix`（固定文件名，便于持续覆盖更新）

---

## 1. 安装

### 方法 A：安装 VSIX（推荐）

1. 打开扩展面板（`Ctrl+Shift+X`）
2. 右上角 `···` → **从 VSIX 安装…**
3. 选择项目目录下的 `codebuddy-history-viewer.vsix`
4. 安装完成后重启窗口

### 方法 B：源码运行（开发调试）

```bash
npm install
npm run compile     # 编译 TS + 拷贝 sql-wasm
# 在 VS Code 中按 F5 启动扩展开发宿主
```

### 重新打包

```bash
npm run package
# → 输出：codebuddy-history-viewer.vsix（固定文件名，覆盖旧产物）
```

`package.json` 中的 `version` 字段决定 VSIX 内部版本号（VS Code 据此判定升级），文件名不再带版本号。

---

## 2. 打开侧边栏

激活扩展后，左侧活动栏会出现 **CodeBuddy 历史** 图标 → 点击即可打开。

> 列表只显示**当前 VS Code 工作区**对应的聊天，跨工作区记录会被过滤。
> 工作区识别规则：`md5(normalize(cwd))` → 与 CodeBuddy IDE `history/<workspaceHash>/` 子目录匹配；
> Windows 大小写盘符（`G:` / `g:`）会同时尝试匹配，避免漏显。

---

## 3. 主界面功能

### 3.1 列表项信息

每条聊天显示：

- **标题**：自定义标题（`title.txt`）> 第一条用户消息摘要
- **预览**：第一条用户消息片段
- **时间**：会话最后一次活动时间（相对时间，如 "5 分钟前"）
- **消息数**
- **状态指示灯**（左侧圆点，见下表）
- **操作按钮**：✏️ 重命名 / 🗑️ 删除（悬停项时出现）

### 3.2 状态指示灯

| 颜色 / 名称 | 含义 |
|---|---|
| 🔵 **执行中**（蓝色闪烁） | CodeBuddy 正在处理该会话的请求（`running` / `active`） |
| 🟠 **等待中** | 等待用户响应或工具调用（`pending`） |
| ⚪ **已完成** | 上一次请求正常结束（`complete`） |
| 🔴 **错误** | 上一次请求失败（`error` / `failed`） |
| 🟢 **空闲** | 会话存在但没有进行中的请求 |
| ✨ **当前会话** | CodeBuddy IDE 聊天框当前打开的会话（高亮） |

状态由后台每 **3 秒** 扫描一次 `index.json`（mtime 缓存，未变化的会话不会重读 JSON）。

### 3.3 当前会话高亮策略

> 由 `statusMonitor.ts` 决策，按优先级从高到低：

1. **fs 中真实出现 `running` 状态的会话**（最强信号）
2. **用户在本插件中点击切换的会话**（手动声明，5 分钟有效期）
3. **mtime 兜底**：当前工作区下最近 30 分钟内 `index.json` mtime 最大的会话
4. **启动宽限期（前 8 秒）**：禁用 mtime 兜底，避免冷启动时把"昨天最后用的会话"错误高亮

---

## 4. 排序与手动拖拽

顶部下拉菜单提供：

- **时间 ↓ 最新** / **时间 ↑ 最早**
- **标题 A→Z** / **标题 Z→A**
- **消息数 ↓ 多** / **消息数 ↑ 少**
- **手动排序**

### 手动拖拽排序

- 切换到「**手动排序**」模式，长按列表项后上下拖动即可
- 拖拽时显示半透明跟随幽灵 + 落点提示
- 顺序通过 `reorderHistory` 消息发回扩展后端，写入 history 根目录的 `index.json`，下次启动自动恢复

> 切换到其他排序方式会以新规则重排，但手动顺序仍被保留；切回「手动排序」即可恢复。

---

## 5. 展开会话 · 查看历史消息

点击列表项的内容区（非标题首行）即可**就地展开**，显示该会话的全部 user 消息：

- 每条消息卡片头部：`消息 N` + 该消息的真实时间
  - 今天：`HH:mm`
  - 其他日期：`M/D HH:mm`
  - 鼠标悬停 `title` 看完整 `toLocaleString()`
- 时间来源（后端 `historyReader.ts`）：
  1. **优先 `requests[].startedAt`**（IDE 写入的请求开始时间，最准）
  2. 兜底 `messages/<id>.json` 的文件 mtime
  3. 最后退到会话目录名（数字时间戳）或 `Date.now()`

> 展开内容只展示提取自 `<user_query>` 标签内的纯用户输入，过滤掉 IDE 注入的 system reminder / images / 上下文片段。

再次点击同一项标题区或别的项会折叠/切换。当后台检测到该会话的 `index.json` 发生变化（写入新消息）时，正在展开的详情会**自动刷新**，无需手动重载。

---

## 6. 跳回 CodeBuddy 聊天框

点击聊天项的标题 → 扩展尝试让 CodeBuddy IDE 切换到该会话，依次执行：

1. **方案 A**：`vscode.extensions.getExtension('Tencent-Cloud.coding-copilot')` → 调用其 `setCurrentConversation`
2. **方案 B**：尝试一组已知命令（`...openConversation` / `...switchConversation` / `...sendMessage` 携带 `conversationId`）
3. **方案 C**（兜底）：执行 `tencentcloud.codingcopilot.chatHistory` 打开历史面板，并提示用户手动选

无论哪一步成功，都会同时把"手动声明的当前会话"立即写入 `statusMonitor`，避免高亮延迟。

---

## 7. 重命名 / 删除

- ✏️ **重命名**：行内输入框，回车保存 / Esc 取消。标题写入会话目录下的 `title.txt`，**不会污染 CodeBuddy IDE 的原始数据**。
- 🗑️ **删除**：弹窗二次确认，确认后**直接删除整个 sessionDir 目录**（不可恢复）。

> 删除是物理删除，请谨慎。CodeBuddy IDE 也会随之失去该会话。

---

## 8. 刷新

顶部 🔄 按钮，或命令面板 `刷新历史记录`。

通常**无需手动刷新**：

- 后台 3 秒扫描会自动捕捉新增 / 修改 / 删除
- `index.json` 内容变化（含新消息）会自动触发 history list 重渲染

---

## 9. 数据来源

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\
└── <accountId>\
    └── CodeBuddyIDE\
        └── <uid>\
            └── history\
                └── <workspaceHash>\          ← MD5(normalize(cwd))
                    ├── index.json            ← 排序记录
                    └── <sessionDir>\          ← 即 conversationId（UUID）
                        ├── index.json        ← messages 列表 + requests + state
                        ├── messages\
                        │   └── <msgId>.json  ← role / message / references / extra
                        └── title.txt        ← 本插件写入的自定义标题
```

辅助：`~/.workbuddy/workbuddy.db`（SQLite）—— 提供 cwd → workspaceHash 的反查，让插件能识别"哪些 history 子目录属于当前工作区"。

> 插件**只读** CodeBuddy 原始数据；写入仅限于 `title.txt` 和 history 根目录的 `index.json`（手动排序）。

---

## 10. 命令清单

| 命令 ID | 标题 |
|---|---|
| `codebuddy-history.refresh` | 刷新历史记录 |
| `codebuddy-history.clear` | 清除历史记录（实际等同刷新） |

可在命令面板（`Ctrl+Shift+P`）调用，或通过侧边栏右上角按钮触发。

---

## 11. 常见问题

**Q：列表显示「暂无历史记录」**
A：

1. 当前 VS Code 工作区是否在 CodeBuddy IDE 里有过对话？
2. 路径 `%LOCALAPPDATA%\CodeBuddyExtension\Data\...\history\<workspaceHash>` 下是否有 sessionDir？
3. Windows 上注意盘符大小写：`G:` 与 `g:` 哈希不同，插件会自动尝试两种，但若 cwd 写法异常仍可能漏识别 → 检查输出面板 `CodeBuddy History` 的日志。

**Q：状态灯不更新 / 当前会话高亮错位**
A：打开 **输出 → CodeBuddy History** 通道查看 `[活跃会话变更]` 日志：

- 显示 "跳过 mtime 兜底候选" → 处于启动宽限期 8 秒
- 显示 `running 会话: …` → fs 已识别正确
- 在插件里**点击一次**目标会话标题可手动声明，立即生效（TTL 5 分钟）

**Q：消息时间显示为 `Date.now()`（看起来都是同一时间）**
A：说明该会话的 `index.json` 缺少 `requests[].startedAt`（旧数据），且消息文件 mtime 也读取失败。属于历史数据问题，新会话不会出现。

**Q：手动排序丢失**
A：手动顺序写入 history 根目录的 `index.json`，若 CodeBuddy IDE 自身重写过该文件可能覆盖。重新拖拽即可。

---

## 12. 项目结构

```
missionlist-plugin/
├── src/
│   ├── extension.ts          # 扩展入口：注册视图 + 命令 + 启动状态监控
│   ├── sidebarProvider.ts    # WebviewView：消息收发、调度后端读写
│   ├── historyReader.ts      # 数据层：扫描 history 目录、读 index.json、
│   │                          #         读 messages、写 title.txt、删除会话、
│   │                          #         读写排序、SQLite 反查 cwd→hash
│   ├── statusMonitor.ts      # 后台 3s 轮询：状态扫描 + 当前会话识别
│   ├── db.ts                 # sql.js + workbuddy.db 访问封装
│   └── webview/
│       ├── main.js           # 前端：渲染列表/详情/搜索/排序/拖拽/状态灯
│       └── style.css         # VS Code 主题变量驱动的样式
├── resources/icon.svg        # 活动栏图标
├── test-data/                # 旧版 JSON 测试样本（仅供参考）
├── package.json              # 含 npm run package 一键打包脚本
└── README.md / USAGE.md
```

---

## 13. 开发提示

- TypeScript 编译输出到 `out/`；webview 资源直接以 `src/webview/*` 为根加载，无需打包前端
- 改 `style.css` / `main.js` 后只需在扩展开发宿主里 `Ctrl+R` 重载窗口即可生效
- `npm run watch` 后台增量编译 `.ts`
- 开发联调日志：**输出 → CodeBuddy History** 通道，前端 `console.log` 也会通过 `debugLog` 消息回传到该通道（详见 `logFromWebview`）

---

**祝使用愉快！**
