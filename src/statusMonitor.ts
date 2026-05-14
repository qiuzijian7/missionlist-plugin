import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { SidebarProvider } from './sidebarProvider';

let monitorInterval: NodeJS.Timeout | undefined;

/**
 * 启动状态监控
 * @param sidebarProvider 侧边栏提供器
 * @returns 返回包含停止方法的对象
 */
export function startStatusMonitor(sidebarProvider: SidebarProvider): { stop(): void } {
    // 每 1.5 秒更新一次状态
    monitorInterval = setInterval(async () => {
        await updateChatStatus(sidebarProvider);
    }, 1500);

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
        // 检测当前激活的会话 ID，始终发送到 webview（确保状态同步）
        const activeSessionId = await detectActiveSession();
        sidebarProvider.updateActiveSession(activeSessionId);
    } catch (error) {
        console.error('更新聊天状态失败:', error);
    }
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

/**
 * 检测当前激活的会话 ID
 * 优先级：WorkBuddy 数据库最近更新的会话 > 文件系统最近修改的会话
 * @returns 当前激活的会话 ID (sessionDir 格式，不带连字符的UUID)，如果没有则返回 null
 */
async function detectActiveSession(): Promise<string | null> {
    try {
        // 方法1（最可靠）：从 WorkBuddy 数据库读取最近更新的会话
        const dbSessionId = detectActiveSessionFromDB();
        if (dbSessionId) {
            return dbSessionId;
        }

        // 方法2：扫描文件系统，找最近修改的会话
        return detectActiveSessionFromFileSystem();
    } catch (error) {
        console.error('检测激活会话失败:', error);
    }

    return null;
}

/**
 * 从 WorkBuddy 数据库检测活跃会话
 * 数据库中 updated_at 在 CodeBuddy 切换会话时会被更新
 */
function detectActiveSessionFromDB(): string | null {
    const dbPath = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
    if (!fs.existsSync(dbPath)) {
        return null;
    }

    try {
        // 查询最近更新的会话（排除已删除的）
        const query = `SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`;
        const result = cp.execSync(`sqlite3 "${dbPath}" "${query}"`, {
            encoding: 'utf-8',
            timeout: 3000,
            windowsHide: true
        });

        const sessionId = result.trim();
        if (sessionId) {
            // 数据库中的 ID 是带连字符的 UUID，需要转换为文件系统目录名格式（不带连字符）
            return sessionId.replace(/-/g, '');
        }
    } catch {
        // sqlite3 命令不可用或查询失败，静默失败
    }

    return null;
}

/**
 * 从文件系统检测活跃会话
 * 通过扫描 index.json 修改时间和 requests 状态来判断
 */
function detectActiveSessionFromFileSystem(): string | null {
    const dataRoot = path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data');
    if (!fs.existsSync(dataRoot)) {
        return null;
    }

    let activeSession: string | null = null;      // 有 active request 的会话
    let mostRecentSession: { sessionDir: string; mtime: number } | null = null;

    try {
        const accountDirs = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const accountId of accountDirs) {
            const codeBuddyDir = path.join(dataRoot, accountId, 'CodeBuddyIDE');
            if (!fs.existsSync(codeBuddyDir)) continue;

            const uidDirs = fs.readdirSync(codeBuddyDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            for (const uid of uidDirs) {
                const historyPath = path.join(codeBuddyDir, uid, 'history');
                if (!fs.existsSync(historyPath)) continue;

                const workspaceDirs = fs.readdirSync(historyPath, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => d.name);

                for (const workspaceHash of workspaceDirs) {
                    const workspacePath = path.join(historyPath, workspaceHash);
                    const sessionDirs = fs.readdirSync(workspacePath, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name);

                    for (const sessionDir of sessionDirs) {
                        try {
                            const sessionPath = path.join(workspacePath, sessionDir);
                            const indexPath = path.join(sessionPath, 'index.json');

                            if (fs.existsSync(indexPath)) {
                                // 检查是否有 active request
                                try {
                                    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                                    const requests = indexData.requests || [];
                                    if (requests.length > 0) {
                                        const lastRequest = requests[requests.length - 1];
                                        if (lastRequest.state === 'active') {
                                            activeSession = sessionDir;
                                        }
                                    }
                                } catch { /* ignore parse errors */ }

                                // 用 index.json 修改时间判断最近活跃
                                const stat = fs.statSync(indexPath);
                                if (!mostRecentSession || stat.mtimeMs > mostRecentSession.mtime) {
                                    mostRecentSession = { sessionDir, mtime: stat.mtimeMs };
                                }
                            }

                            // 也检查 messages 目录修改时间
                            const messagesDir = path.join(sessionPath, 'messages');
                            if (fs.existsSync(messagesDir)) {
                                const msgStat = fs.statSync(messagesDir);
                                if (!mostRecentSession || msgStat.mtimeMs > mostRecentSession.mtime) {
                                    mostRecentSession = { sessionDir, mtime: msgStat.mtimeMs };
                                }
                            }
                        } catch { /* ignore individual session errors */ }
                    }
                }
            }
        }
    } catch (error) {
        console.error('文件系统扫描失败:', error);
    }

    // 优先返回有 active request 的会话
    if (activeSession) {
        return activeSession;
    }

    // 否则返回最近修改的会话（仅当修改时间在最近 30 分钟内才视为活跃）
    if (mostRecentSession && (Date.now() - mostRecentSession.mtime) < 30 * 60 * 1000) {
        return mostRecentSession.sessionDir;
    }

    return null;
}
