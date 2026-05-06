import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';

let monitorInterval: NodeJS.Timeout | undefined;

/**
 * 启动状态监控
 * @param sidebarProvider 侧边栏提供器
 * @returns 返回包含停止方法的对象
 */
export function startStatusMonitor(sidebarProvider: SidebarProvider): { stop(): void } {
    // 每 3 秒更新一次状态
    monitorInterval = setInterval(async () => {
        await updateChatStatus(sidebarProvider);
    }, 3000);

    // 立即执行一次
    updateChatStatus(sidebarProvider);

    return {
        stop(): void {
            if (monitorInterval) {
                clearInterval(monitorInterval);
                monitorInterval = undefined;
            }
        }
    };
}

/**
 * 更新聊天状态
 */
async function updateChatStatus(sidebarProvider: SidebarProvider): Promise<void> {
    try {
        // 方法1：检查 CodeBuddy 进程状态
        const statusMap = await checkCodeBuddyProcesses();

        // 方法2：读取 CodeBuddy 状态文件（如果存在）
        const fileStatus = await readCodeBuddyStatus();
        
        // 合并状态
        const mergedStatus = { ...statusMap, ...fileStatus };

        // 发送状态更新到 webview
        if (Object.keys(mergedStatus).length > 0) {
            sidebarProvider.updateStatus(mergedStatus);
        }
    } catch (error) {
        console.error('更新聊天状态失败:', error);
    }
}

/**
 * 检查 CodeBuddy 相关进程
 */
async function checkCodeBuddyProcesses(): Promise<Record<string, string>> {
    const statusMap: Record<string, string> = {};

    try {
        // 使用 VS Code API 检查终端活动状态
        const terminals = vscode.window.terminals;
        
        for (const terminal of terminals) {
            const name = terminal.name.toLowerCase();
            // 检查是否是 CodeBuddy 相关的终端
            if (name.includes('codebuddy') || name.includes('copilot') || name.includes('agent')) {
                // 终端存在表示可能有活动
                statusMap['active-terminal'] = 'running';
            }
        }

        // 检查是否有正在运行的任务
        // 注意：这是一个简化的实现，实际应该读取 CodeBuddy 的状态 API
        const activeTasks = await vscode.tasks.fetchTasks();
        for (const task of activeTasks) {
            if (task.name.toLowerCase().includes('codebuddy') || 
                task.name.toLowerCase().includes('copilot')) {
                statusMap['active-task'] = 'running';
            }
        }

    } catch (error) {
        console.error('检查进程失败:', error);
    }

    return statusMap;
}

/**
 * 读取 CodeBuddy 状态文件
 */
async function readCodeBuddyStatus(): Promise<Record<string, string>> {
    const statusMap: Record<string, string> = {};
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    try {
        // 检查可能的状态文件位置
        const possibleStatusFiles = [
            path.join(os.homedir(), '.codebuddy', 'status.json'),
            path.join(os.homedir(), '.codebuddy', 'running.json'),
            path.join(os.homedir(), '.codebuddycn', 'status.json'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 
                     'tencent-cloud.coding-copilot', 'status.json')
        ];

        for (const statusFile of possibleStatusFiles) {
            if (fs.existsSync(statusFile)) {
                const data = fs.readFileSync(statusFile, 'utf-8');
                const statusData = JSON.parse(data);
                
                // 假设状态文件格式为 { "chat-id": "running" }
                for (const [chatId, status] of Object.entries(statusData)) {
                    statusMap[chatId] = status as string;
                }
            }
        }

        // 模拟：随机分配一些状态用于测试
        if (Object.keys(statusMap).length === 0) {
            // 如果没有真实状态文件，可以启用模拟模式
            // statusMap['chat-001'] = Math.random() > 0.5 ? 'running' : 'idle';
        }

    } catch (error) {
        console.error('读取状态文件失败:', error);
    }

    return statusMap;
}

/**
 * 获取状态显示文本
 */
export function getStatusText(status: string): string {
    const statusMap: Record<string, string> = {
        'idle': '空闲',
        'running': '执行中',
        'error': '错误',
        'completed': '已完成',
        'pending': '等待中'
    };
    return statusMap[status] || status;
}

/**
 * 获取状态 CSS 类名
 */
export function getStatusClass(status: string): string {
    const classMap: Record<string, string> = {
        'idle': 'status-idle',
        'running': 'status-running',
        'error': 'status-error',
        'completed': 'status-completed',
        'pending': 'status-pending'
    };
    return classMap[status] || 'status-unknown';
}
