import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { startStatusMonitor } from './statusMonitor';

export function activate(context: vscode.ExtensionContext) {
    console.log('CodeBuddy History Viewer 扩展已激活');

    // 创建输出通道，用于调试日志
    const outputChannel = vscode.window.createOutputChannel('CodeBuddy History');
    context.subscriptions.push(outputChannel);

    // 创建侧边栏提供器
    const sidebarProvider = new SidebarProvider(context.extensionUri);

    // 注册侧边栏视图
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'codebuddy-history.view',
            sidebarProvider
        )
    );

    // 注册刷新命令
    const refreshCommand = vscode.commands.registerCommand(
        'codebuddy-history.refresh',
        () => {
            sidebarProvider.refresh();
        }
    );

    // 注册清除命令
    const clearCommand = vscode.commands.registerCommand(
        'codebuddy-history.clear',
        () => {
            sidebarProvider.clearHistory();
        }
    );

    context.subscriptions.push(refreshCommand, clearCommand);

    // 启动状态监控（传入输出通道）
    const statusMonitor = startStatusMonitor(sidebarProvider, outputChannel);
    context.subscriptions.push({ dispose: () => statusMonitor.stop() });
}

export function deactivate() {}
