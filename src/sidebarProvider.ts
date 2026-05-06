import * as vscode from 'vscode';
import { readCodeBuddyHistory, renameChatHistory, deleteChatHistory, readChatDetail, saveHistoryOrder } from './historyReader';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 监听来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'openChat':
                        vscode.commands.executeCommand('codebuddy.openChat');
                        break;
                    case 'openSessionInCodeBuddy':
                        this.openSessionInCodeBuddy(message.sessionId, message.sessionDir, message.workspaceHash);
                        break;
                    case 'loadChatDetail':
                        await this.loadChatDetail(message.chatId);
                        break;
                    case 'reorderHistory':
                        await this.saveHistoryOrder(message.data);
                        break;
                    case 'renameChat':
                        await this.renameChat(message.chatId, message.newTitle);
                        break;
                    case 'deleteChat':
                        await this.deleteChat(message.chatId, message.title);
                        break;
                }
            }
        );

        // 初始加载历史记录
        this.refresh();
    }

    public async refresh() {
        if (this._view) {
            // 获取当前工作区路径，用于过滤只显示当前项目的聊天记录
            const currentWorkspace = this._getCurrentWorkspacePath();
            const history = await readCodeBuddyHistory(currentWorkspace);

            this._view.webview.postMessage({
                type: 'updateHistory',
                data: history
            });
        }
    }

    /**
     * 获取当前 VS Code 打开的工作区路径
     */
    private _getCurrentWorkspacePath(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    /**
     * 在当前 CodeBuddy IDE 中直接切换到指定的会话
     * 
     * 借鉴 CodeBuddy 内部 ChatHistoryList 组件的 onSelectConversation 逻辑：
     * 1. ConversationViewService.setCurrentConversation(id) — 通过 RPC 设置当前会话
     * 2. navigate("/") — webview 路由跳回聊天主页
     * 
     * 由于外部插件无法直接调用 RPC，采用以下策略：
     * - 方案 A：通过 CodeBuddy 扩展 API（getExtension）访问内部服务
     * - 方案 B：通过命令系统间接触发切换（chatHistory + focus）
     * - 方案 C：打开历史面板让用户手动点击
     * 
     * sessionDir（会话目录名，UUID 格式）就是 genie 内部的 conversationId。
     */
    private async openSessionInCodeBuddy(sessionId?: string, sessionDir?: string, workspaceHash?: string): Promise<void> {
        try {
            // sessionDir 就是 CodeBuddy IDE 的 conversationId（UUID 格式）
            const conversationId = sessionDir || '';
            if (!conversationId) {
                vscode.window.showWarningMessage('无法打开：缺少会话标识 (conversationId)');
                return;
            }

            console.log('[HistoryViewer] Attempting to switch to conversation:', conversationId);

            // 获取所有已注册命令
            const allCommands = await vscode.commands.getCommands(true);
            
            // ====== 方案 A：通过 CodeBuddy 扩展 API 直接调用 setCurrentConversation ======
            const codeBuddyExt = vscode.extensions.getExtension('Tencent-Cloud.coding-copilot');
            if (codeBuddyExt) {
                try {
                    // 确保扩展已激活
                    if (!codeBuddyExt.isActive) {
                        await codeBuddyExt.activate();
                    }
                    const api = codeBuddyExt.exports;
                    
                    // 尝试通过 exports API 调用 setCurrentConversation
                    if (api) {
                        // 尝试多种可能的 API 路径
                        const setConversation = 
                            api.setCurrentConversation ||
                            api.chatService?.setCurrentConversation ||
                            api.conversationService?.setCurrentConversation ||
                            api.historyService?.setCurrentConversation;
                        
                        if (typeof setConversation === 'function') {
                            await setConversation(conversationId);
                            // 聚焦聊天面板
                            await this._focusChatPanel(allCommands);
                            console.log('[HistoryViewer] Switched via extension API');
                            return;
                        }
                    }
                } catch (e) {
                    console.log('[HistoryViewer] Extension API approach failed:', e);
                }
            }

            // ====== 方案 B：通过已知命令组合切换 ======
            // 策略：先调用 chatHistory 打开历史面板（这会触发 activatePage({path:"/history"})）
            // 然后立即聚焦聊天面板（触发 activatePage({path:"/"})），期间依靠内部状态同步
            
            // B-1: 尝试直接执行 clearSession 后通过 sendMessage 带 conversationId
            // CodeBuddy 的 getChatCompletions 逻辑：
            // - 如果 conversationId 存在 → 只清除 discarded versions，然后 dispatch
            // - 如果 conversationId 不存在 → 创建新会话，调用 setCurrentConversation
            // 所以对于已有的 conversationId，我们需要另一种方式
            
            // B-2: 尝试通过模拟 webview RPC 调用
            // 通过 vscode.commands 执行一个带 conversationId 参数的 chatService 命令
            const chatServiceCommands = [
                'tencentcloud.codingcopilot.chat.openConversation',
                'tencentcloud.codingcopilot.openConversation', 
                'tencentcloud.codingcopilot.chat.switchConversation',
                'tencentcloud.codingcopilot.switchConversation',
                'tencentcloud.codingcopilot.chat.setCurrentConversation',
            ];
            
            for (const cmd of chatServiceCommands) {
                if (allCommands.includes(cmd)) {
                    try {
                        await vscode.commands.executeCommand(cmd, conversationId);
                        await this._focusChatPanel(allCommands);
                        console.log(`[HistoryViewer] Switched via command: ${cmd}`);
                        return;
                    } catch { /* continue to next */ }
                }
            }

            // B-3: 利用 sendMessage 命令的副作用
            // 虽然 getChatCompletions 对已有的 conversationId 不会调 setCurrentConversation，
            // 但命令入口可能在 dispatch 前先做了 setCurrentConversation
            const sendMsgCandidates = [
                'tencentcloud.codingcopilot.chat.sendMessage',
                'tencentcloud.codingcopilot.sendMessage',
            ];
            
            for (const cmd of sendMsgCandidates) {
                if (allCommands.includes(cmd)) {
                    try {
                        // 传入 conversationId，用空消息触发
                        // 从源码看：getChatCompletions 如果 conversationId 存在，
                        // 会走到 chatDispatcher.dispatch(re, signal)
                        // 但在 dispatch 之前可能 chatViewService 已经切换了视图
                        await vscode.commands.executeCommand(cmd, {
                            message: '',
                            conversationId: conversationId,
                            options: { conversationId: conversationId }
                        });
                    } catch {
                        // 空消息可能报错，但副作用可能已生效
                    }
                    
                    // 聚焦聊天面板
                    await this._focusChatPanel(allCommands);
                    console.log(`[HistoryViewer] Attempted switch via: ${cmd}`);
                    return;
                }
            }

            // ====== 方案 C（最终兜底）：打开历史面板 + 提示用户 ======
            // 利用 chatHistory 命令打开历史面板，让用户手动选择
            const historyCmdCandidates = [
                'tencentcloud.codingcopilot.chatHistory',
            ];
            
            for (const cmd of historyCmdCandidates) {
                if (allCommands.includes(cmd)) {
                    try {
                        await vscode.commands.executeCommand(cmd);
                        vscode.window.showInformationMessage(
                            `请在历史面板中点击对应的会话来切换`
                        );
                        console.log('[HistoryViewer] Opened history panel as fallback');
                        return;
                    } catch { /* continue */ }
                }
            }

            // 最终兜底：聚焦聊天面板
            await this._focusChatPanel(allCommands);
            vscode.window.showWarningMessage('无法直接切换会话，已聚焦到聊天面板');
            
        } catch (error) {
            vscode.window.showErrorMessage(`无法打开 CodeBuddy 会话: ${error}`);
        }
    }

    /**
     * 聚焦 CodeBuddy 聊天面板
     * CodeBuddy 内部使用 `coding-copilot.webviews.chat.focus` 来聚焦
     */
    private async _focusChatPanel(allCommands?: string[]): Promise<void> {
        const focusCandidates = [
            'coding-copilot.webviews.chat.focus',           // CHAT_VIEW_ID.focus (内部使用)
            'Tencent-Cloud.coding-copilot.webviews.chat.focus',
            'tencentcloud.codingcopilot.chat.focus',
            'workbench.view.extension.coding-copilot-chat',  // viewContainer focus
        ];

        if (!allCommands) {
            allCommands = await vscode.commands.getCommands(true);
        }

        for (const cmd of focusCandidates) {
            if (allCommands.includes(cmd)) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    return;
                } catch { /* continue */ }
            }
        }
    }

    public clearHistory() {
        vscode.window.showInformationMessage('历史记录已刷新');
        this.refresh();
    }

    /**
     * 加载聊天记录详情并发送到 webview 显示
     * @param chatId 聊天ID
     */
    public async loadChatDetail(chatId: string): Promise<void> {
        try {
            const chatDetail = await readChatDetail(chatId);
            if (chatDetail && this._view) {
                this._view.webview.postMessage({
                    type: 'updateChatDetail',
                    data: chatDetail
                });
            } else if (!chatDetail) {
                vscode.window.showErrorMessage('无法加载聊天记录详情');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`加载聊天详情失败: ${error}`);
        }
    }

    /**
     * 重命名聊天记录
     * @param chatId 聊天ID
     * @param newTitle 新标题
     */
    public async renameChat(chatId: string, newTitle: string): Promise<void> {
        try {
            const result = await renameChatHistory(chatId, newTitle);
            if (result) {
                vscode.window.showInformationMessage(`已重命名为: ${newTitle}`);
                await this.refresh();
            } else {
                vscode.window.showErrorMessage('重命名失败');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`重命名失败: ${error}`);
        }
    }

    /**
     * 删除聊天记录
     * @param chatId 聊天ID
     * @param title 聊天标题（用于确认提示）
     */
    public async deleteChat(chatId: string, title: string): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `确定要删除"${title}"吗？`,
            { modal: true },
            '删除',
            '取消'
        );

        if (confirmation === '删除') {
            try {
                const result = await deleteChatHistory(chatId);
                if (result) {
                    vscode.window.showInformationMessage('已删除该对话');
                    await this.refresh();
                } else {
                    vscode.window.showErrorMessage('删除失败');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`删除失败: ${error}`);
            }
        }
    }

    /**
     * 保存历史记录的新排序顺序
     * @param orderedIds 按新顺序排列的聊天 ID 列表
     */
    public async saveHistoryOrder(orderedIds: string[]): Promise<void> {
        try {
            // 调用 historyReader 中的函数保存排序
            await saveHistoryOrder(orderedIds);
            vscode.window.showInformationMessage('排序已保存');
        } catch (error) {
            vscode.window.showErrorMessage(`保存排序失败: ${error}`);
        }
    }

    /**
     * 更新聊天状态
     * @param statusMap 状态映射表 { chatId: status }
     */
    public updateStatus(statusMap: Record<string, string>): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateStatus',
                data: statusMap
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'style.css')
        );

        return `<!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>CodeBuddy 历史</title>
            </head>
            <body>
                <div id="app">
                    <!-- 列表视图 -->
                    <div id="listView">
                        <div class="header">
                            <h2>CodeBuddy 聊天历史</h2>
                            <div class="header-actions">
                                <select id="sortSelect" title="排序方式">
                                    <option value="time-desc">时间 ↓ 最新</option>
                                    <option value="time-asc">时间 ↑ 最早</option>
                                    <option value="title-asc">标题 A→Z</option>
                                    <option value="title-desc">标题 Z→A</option>
                                    <option value="messages-desc">消息数 ↓ 多</option>
                                    <option value="messages-asc">消息数 ↑ 少</option>
                                </select>
                                <button id="refreshBtn" title="刷新">🔄</button>
                            </div>
                        </div>
                        <div id="historyList"></div>
                        <div id="emptyState" class="empty-state" style="display: none;">
                            <p>暂无历史记录</p>
                        </div>
                    </div>
                </div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
