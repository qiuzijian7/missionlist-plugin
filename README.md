# CodeBuddy History Viewer

一个 VS Code 扩展，用于在左侧活动栏显示 CodeBuddy 的历史聊天内容。

## 功能特性

- 📋 在左侧活动栏添加「CodeBuddy 历史」按钮
- 💬 显示 CodeBuddy 聊天历史记录列表
- 🔄 支持刷新历史记录
- 🔃 支持自定义排序（时间、标题、消息数）
- 🟢 实时状态显示（执行中、空闲、错误等）
- 🎨 使用 VS Code 主题配色
- 📱 响应式设计

## 安装方法

### 方法一：从 VSIX 安装
1. 下载 `codebuddy-history-viewer.vsix`
2. 在 VS Code 中：`扩展` → `···` → `从 VSIX 安装...`
3. 选择下载的 `.vsix` 文件

### 方法二：从源码编译
```bash
# 克隆项目
cd missionlist-plugin

# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 打包为 VSIX
npx vsce package
```

## 使用方法

1. 安装扩展后，左侧活动栏会出现「CodeBuddy 历史」图标
2. 点击图标，侧边栏会显示聊天历史列表
3. 点击右上角刷新按钮可以重新加载历史记录
4. 点击历史记录项可以打开对应的对话

## 测试扩展

### 方法一：按 F5 调试运行
1. 在 VS Code 中打开本项目
2. 按 `F5` 启动扩展开发宿主
3. 在新打开的 VS Code 窗口中，查看左侧活动栏
4. 点击「CodeBuddy 历史」图标测试功能

### 方法二：使用测试数据
1. 将 `test-data/expert-history.json` 复制到 `~/.codebuddy/` 目录
2. 或者在 `src/historyReader.ts` 中添加测试路径：
   ```typescript
   path.join(os.homedir(), 'CustomWorkspaces', 'AIProjects', 'missionlist-plugin', 'test-data', 'expert-history.json')
   ```

## 数据存储位置

扩展会从以下位置读取 CodeBuddy 历史记录：

- `~/.codebuddy/expert-history.json`
- `%APPDATA%/Code/User/globalStorage/tencent-cloud.coding-copilot/history.json`
- VS Code 工作区存储数据库 (`.vscdb`)

## 开发指南

### 项目结构
```
missionlist-plugin/
├── src/
│   ├── extension.ts          # 扩展入口
│   ├── sidebarProvider.ts    # 侧边栏提供器
│   ├── historyReader.ts      # 历史记录读取器
│   └── webview/
│       ├── main.js           # Webview 前端逻辑
│       └── style.css        # Webview 样式
├── resources/
│   └── icon.svg             # 活动栏图标
├── package.json              # 扩展配置
├── tsconfig.json             # TypeScript 配置
└── README.md                # 说明文档
```

### 调试运行
1. 在 VS Code 中打开项目
2. 按 `F5` 启动扩展开发宿主
3. 在新窗口中测试扩展功能

## 技术栈

- TypeScript
- VS Code Extension API
- Webview API
- Node.js (fs, path, os)

## 注意事项

- 当前版本需要从 CodeBuddy 配置文件中读取历史记录
- 如果找不到历史记录文件，会显示「暂无历史记录」
- 支持从 SQLite 数据库 (`.vscdb`) 读取（需要额外配置）

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！

## 更新日志

### v0.1.0 (2026-05-06)
- ✨ 初始版本发布
- 📋 添加左侧活动栏按钮
- 💬 显示聊天历史记录
- 🔄 支持刷新功能
