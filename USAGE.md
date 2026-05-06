# CodeBuddy History Viewer - 使用指南

## 📦 安装扩展

### 方法一：安装打包好的 VSIX
1. 在 VS Code 中，点击左侧扩展图标（`Ctrl+Shift+X`）
2. 点击扩展面板右上角的 `···` 菜单
3. 选择「从 VSIX 安装...」
4. 选择项目目录下的 `codebuddy-history-viewer-0.1.0.vsix` 文件
5. 安装完成后重启 VS Code

### 方法二：从源码运行（开发模式）
1. 在 VS Code 中打开本项目文件夹
2. 按 `F5` 启动扩展开发宿主
3. 新的 VS Code 窗口会打开，扩展已自动加载

## 🎯 功能使用

### 1. 打开历史侧边栏
- 安装扩展后，左侧活动栏会出现 📋 图标
- 点击该图标，侧边栏会显示「CodeBuddy 历史」面板

### 2. 查看聊天历史
- 侧边栏会列出所有 CodeBuddy 聊天记录
- 每条记录显示：
  - 📝 对话标题
  - 💬 消息预览
  - ⏰ 时间信息
  - 🔢 消息数量

### 3. 自定义排序
侧边栏顶部提供了排序下拉菜单，支持以下排序方式：
- **时间 ↓ 最新**：按时间降序（默认，最新对话在前）
- **时间 ↑ 最早**：按时间升序（最早对话在前）
- **标题 A→Z**：按标题字母升序排列
- **标题 Z→A**：按标题字母降序排列
- **消息数 ↓ 多**：按消息数量降序（消息最多的在前）
- **消息数 ↑ 少**：按消息数量升序（消息最少的在前）

选择排序方式后，列表会立即重新排序。

### 4. 实时状态显示 🔃
扩展会自动监控 CodeBuddy 聊天状态，并在侧边栏中实时更新：

**状态指示器**：
- 🟢 **空闲** (绿色) - 对话空闲，等待输入
- 🔵 **执行中** (蓝色闪烁) - AI 正在处理请求
- 🔴 **错误** (红色) - 执行发生错误
- ⚪ **已完成** (灰色) - 对话已结束
- 🟠 **等待中** (橙色) - 等待用户响应或工具调用

**状态更新机制**：
- 每 3 秒自动检查一次状态
- 状态变化时立即更新界面
- 支持从多个数据源读取状态

**测试状态功能**：
1. 将 `test-data/status.json` 复制到 `~/.codebuddy/status.json`
2. 或修改 `src/statusMonitor.ts` 中的状态文件路径
3. 重新编译并刷新扩展

### 3. 刷新历史记录
- 点击侧边栏右上角的 🔄 刷新按钮
- 扩展会重新读取 CodeBuddy 历史数据

### 4. 打开对话
- 点击任意历史记录项
- 会自动打开 CodeBuddy 对话窗口

## 📂 数据来源

扩展会从以下位置读取 CodeBuddy 历史记录：

```
# Windows
C:\Users\<用户名>\.codebuddy\expert-history.json
C:\Users\<用户名>\.codebuddycn\expert-history.json
C:\Users\<用户名>\AppData\Roaming\Code\User\globalStorage\tencent-cloud.coding-copilot\history.json

# macOS / Linux
~/.codebuddy/expert-history.json
~/.codebuddycn/expert-history.json
```

## 🛠️ 常见问题

### Q: 侧边栏显示「暂无历史记录」
**A**: 请确保：
1. CodeBuddy 已经有聊天记录
2. 历史记录文件存在于上述路径中
3. 文件格式是正确的 JSON 格式

### Q: 如何生成测试数据？
**A**: 将项目下的 `test-data/expert-history.json` 复制到 `~/.codebuddy/` 目录：
```bash
# Windows PowerShell
Copy-Item "test-data\expert-history.json" "$Home\.codebuddy\"
```

### Q: 如何自定义历史记录路径？
**A**: 编辑 `src/historyReader.ts`，在 `possiblePaths` 数组中添加你的路径，然后重新编译：
```bash
npm run compile
```

## 🚀 开发调试

### 项目结构
```
missionlist-plugin/
├── src/                      # TypeScript 源码
│   ├── extension.ts          # 扩展入口
│   ├── sidebarProvider.ts    # 侧边栏 Webview
│   ├── historyReader.ts      # 历史记录读取
│   └── webview/             # 前端资源
│       ├── main.js           # Webview JS
│       └── style.css        # Webview CSS
├── out/                      # 编译输出（不要编辑）
├── resources/               # 静态资源
│   └── icon.svg             # 活动栏图标
├── test-data/               # 测试数据
├── package.json             # 扩展配置
├── tsconfig.json            # TypeScript 配置
└── README.md               # 项目说明
```

### 调试步骤
1. 在 VS Code 中打开项目
2. 按 `F5` 启动调试
3. 在扩展开发宿主窗口中测试功能
4. 修改代码后，在调试窗口中按 `Ctrl+Shift+F5` 重启

### 打包发布
```bash
# 安装打包工具（已完成）
npm install -g @vscode/vsce

# 打包为 VSIX
npx vsce package

# 输出：codebuddy-history-viewer-0.1.0.vsix
```

## 📝 数据格式

`expert-history.json` 文件格式示例：
```json
[
  {
    "id": "chat-001",
    "title": "React 组件开发",
    "preview": "帮我创建一个 React 函数组件...",
    "timestamp": 1715000000000,
    "messages": [
      {
        "role": "user",
        "content": "帮我创建一个 React 组件",
        "timestamp": 1715000000000
      },
      {
        "role": "assistant",
        "content": "好的，我来帮你...",
        "timestamp": 1715000001000
      }
    ]
  }
]
```

## 🎨 自定义样式

要修改侧边栏外观，编辑 `src/webview/style.css`：
- 使用 CSS 变量引用 VS Code 主题色（如 `var(--vscode-foreground)`）
- 修改后会自动热更新（如果启动了 watch 模式）

## 📞 支持

如有问题或建议，请：
1. 查看项目 README.md
2. 提交 Issue
3. 联系开发者

---

**祝使用愉快！** 🎉
