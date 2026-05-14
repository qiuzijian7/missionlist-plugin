import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SidebarProvider } from './sidebarProvider';
import { querySqlite, getWorkBuddyDbPath } from './db';

let monitorInterval: NodeJS.Timeout | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activeSidebarProvider: SidebarProvider | undefined;

/** 状态扫描 mtime 缓存：chatId → { status, mtimeMs } */
const statusMtimeCache = new Map<string, { status: string; mtimeMs: number }>();

/** 上一次的活跃会话 ID，用于变化检测减少日志 */
let lastActiveSessionId: string | null = null;
/** 上一次的状态映射，用于变化检测减少日志 */
let lastStatusMapJson: string = '';

/**
 * 手动设置的"当前活跃会话"——用户在插件里点击切换时由 sidebarProvider 调用。
 * 优先级高于 fs mtime 兜底，但低于 fs 中检测到的 running 状态会话。
 * 设置时间用于让较新写入的会话在合理窗口后重新接管。
 */
let manualActiveSessionDir: string | null = null;
let manualActiveSetAt: number = 0;
/** 手动设置的有效期：用户切换后 5 分钟内强制保持，过后回归 fs 兜底逻辑 */
const MANUAL_ACTIVE_TTL_MS = 5 * 60 * 1000;

/**
 * 由外部（用户操作）声明当前活跃会话的 sessionDir。
 * 立即生效，无需等下一轮扫描。
 */
export function setManualActiveSession(sessionDir: string | null): void {
    manualActiveSessionDir = sessionDir;
    manualActiveSetAt = Date.now();
    // 立即触发一次状态更新，把新的 activeSessionId 推送给 webview
    if (activeSidebarProvider) {
        updateChatStatus(activeSidebarProvider).catch(() => {});
    }
}

/**
 * 启动状态监控
 */
export function startStatusMonitor(
    sidebarProvider: SidebarProvider,
    channel?: vscode.OutputChannel
): { stop(): void } {
    outputChannel = channel;
    activeSidebarProvider = sidebarProvider;

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
            activeSidebarProvider = undefined;
            statusMtimeCache.clear();
        }
    };
}

function log(msg: string): void {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${timestamp}] ${msg}`;
    outputChannel?.appendLine(line);
    console.log(`[HistoryViewer] ${msg}`);
}

/**
 * 获取当前 VS Code 工作区路径
 */
function getCurrentWorkspacePath(): string | undefined {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
        return wsFolders[0].uri.fsPath;
    }
    return undefined;
}

/**
 * 计算当前工作区的候选 hash 列表（兼容 Windows 大小写盘符）
 */
function getCurrentWorkspaceHashes(): string[] | null {
    const wsPath = getCurrentWorkspacePath();
    if (!wsPath) { return null; }
    const normalized = path.normalize(wsPath);
    const hashes = [crypto.createHash('md5').update(normalized).digest('hex')];
    if (process.platform === 'win32' && /^[a-zA-Z]:/.test(normalized)) {
        const flipped = normalized[0] === normalized[0].toLowerCase()
            ? normalized[0].toUpperCase() + normalized.slice(1)
            : normalized[0].toLowerCase() + normalized.slice(1);
        const flippedHash = crypto.createHash('md5').update(flipped).digest('hex');
        if (flippedHash !== hashes[0]) {
            hashes.push(flippedHash);
        }
    }
    return hashes;
}

/**
 * 更新聊天状态：活跃会话 + 请求状态
 */
async function updateChatStatus(sidebarProvider: SidebarProvider): Promise<void> {
    try {
        // 仅在当前工作区范围内扫描，避免推送其他工作区的活跃会话 ID
        const filterHashes = getCurrentWorkspaceHashes();

        // 1. 扫描文件系统获取所有会话状态（含活跃会话候选，限定当前工作区）
        const fsResult = scanFromFileSystem(filterHashes);

        // 2. 决定最终活跃会话：
        //    - fs 检测到 running 的会话最高优先级（实时反映正在执行）
        //    - 手动声明的会话次之（用户刚在插件里点击切换）
        //    - fs mtime 兜底最低优先级
        let activeSessionId = fsResult.activeSessionId;

        const manualValid =
            manualActiveSessionDir &&
            (Date.now() - manualActiveSetAt) < MANUAL_ACTIVE_TTL_MS;

        if (manualValid) {
            // 校验手动声明的 sessionDir 仍属于当前工作区且存在
            const manualChatId = Object.keys(fsResult.statusMap).find(
                id => id.endsWith('/' + manualActiveSessionDir!)
            );
            if (manualChatId) {
                const manualStatus = fsResult.statusMap[manualChatId];
                // 仅当 fs 没找到 running，或 fs 找到的也不是 running 时，用手动值覆盖
                const fsActiveStatus = fsResult.activeSessionId
                    ? Object.entries(fsResult.statusMap).find(
                        ([id]) => id.endsWith('/' + fsResult.activeSessionId)
                    )?.[1]
                    : undefined;
                if (fsActiveStatus !== 'running' || manualStatus === 'running') {
                    activeSessionId = manualActiveSessionDir;
                }
            } else {
                // 已不在当前工作区列表中，丢弃手动值
                manualActiveSessionDir = null;
            }
        }

        // 3. 变化检测：仅在状态变化时输出日志
        const statusMapJson = JSON.stringify(fsResult.statusMap);
        const statusChanged = statusMapJson !== lastStatusMapJson;
        const activeChanged = activeSessionId !== lastActiveSessionId;

        if (statusChanged || activeChanged) {
            if (activeChanged) {
                log(`[活跃会话变更] ${lastActiveSessionId || '(无)'} → ${activeSessionId || '(无)'}`);
                log(`[活跃会话变更] 共扫描到 ${Object.keys(fsResult.statusMap).length} 个会话`);
                // 输出全部 chatId（workspaceHash/sessionDir），供与 webview 端 chat.id 对比
                const allChatIds = Object.keys(fsResult.statusMap);
                if (allChatIds.length > 0) {
                    log(`[活跃会话变更] 所有 chatId 列表:`);
                    allChatIds.forEach(id => log(`  - ${id}  (status=${fsResult.statusMap[id]})`));
                }
            }
            if (statusChanged) {
                const runningSessions = Object.entries(fsResult.statusMap)
                    .filter(([_, s]) => s === 'running')
                    .map(([id]) => id);
                if (runningSessions.length > 0) {
                    log(`运行中会话: ${runningSessions.join(', ')}`);
                }
            }
            lastStatusMapJson = statusMapJson;
            lastActiveSessionId = activeSessionId;
        }

        // 4. 发送给 webview（变更检测在 sidebarProvider 内部处理）
        sidebarProvider.updateActiveSession(activeSessionId);
        sidebarProvider.updateStatus(fsResult.statusMap);

        // 5. 若任意 index.json 内容发生变化（写入了新消息或请求状态变化），
        //    触发 history list 刷新——webview 端会在 updateHistory 时
        //    对仍处于展开状态的会话重新拉取 detail，让新消息可见
        if (fsResult.contentChanged) {
            sidebarProvider.refresh().catch(() => {});
        }
    } catch (error) {
        log(`更新聊天状态失败: ${error}`);
    }
}

/** 暴露给 sidebarProvider 用于 webview 回传日志 */
export function logFromWebview(msg: string): void {
    log(`[Webview] ${msg}`);
}

/** 尝试多个可能的 workbuddy.db 路径 */
function findWorkBuddyDbPaths(): string[] {
    const home = os.homedir();
    const candidates = [
        path.join(home, '.workbuddy', 'workbuddy.db'),
        path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'workbuddy.db'),
        path.join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'workbuddy.db'),
        path.join(home, 'AppData', 'Local', 'Tencent', 'CodeBuddy', 'workbuddy.db'),
        path.join(home, 'AppData', 'Roaming', 'Tencent', 'CodeBuddy', 'workbuddy.db'),
    ];
    return candidates;
}

/**
 * 从 WorkBuddy 数据库检测活跃会话
 * 尝试多个可能的 DB 路径
 */
async function detectActiveSessionFromDB(): Promise<string | null> {
    const candidates = findWorkBuddyDbPaths();
    for (const dbPath of candidates) {
        if (!fs.existsSync(dbPath)) { continue; }

        try {
            const results = await querySqlite(
                dbPath,
                `SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`
            );

            if (results.length > 0 && results[0].values.length > 0) {
                const sessionId = String(results[0].values[0][0]);
                if (sessionId) {
                    const dirName = sessionId.replace(/-/g, '');
                    return dirName;
                }
            }
        } catch (error) {
            log(`DB 查询失败 (${dbPath}): ${error}`);
        }
    }

    return null;
}

interface FileScanResult {
    /** 活跃会话 sessionDir（供 DB 优先覆盖后兜底） */
    activeSessionId: string | null;
    /** chatId (workspaceHash/sessionDir) → 请求状态 */
    statusMap: Record<string, string>;
    /** 本次扫描是否检测到任何 index.json 的 mtime 变化（有新消息写入或会话状态更新） */
    contentChanged: boolean;
}

/**
 * 扫描文件系统获取所有会话的请求状态
 * 使用 mtime 缓存，仅重新读取有变化的 index.json
 * @param filterHashes 当前工作区的候选 hash 列表；只在该范围内挑选活跃会话候选。
 *                     statusMap 仍包含所有扫描到的会话（避免清缓存）。
 */
function scanFromFileSystem(filterHashes?: string[] | null): FileScanResult {
    let bestActiveDir: string | null = null;
    let bestActiveScore = -1;
    const statusMap: Record<string, string> = {};
    const now = Date.now();
    const seenChatIds = new Set<string>();
    let contentChanged = false;

    const dataRoot = path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data');
    if (!fs.existsSync(dataRoot)) {
        return { activeSessionId: null, statusMap, contentChanged };
    }

    try {
        const accountDirs = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(d => d.isDirectory()).map(d => d.name);

        for (const accountId of accountDirs) {
            const codeBuddyDir = path.join(dataRoot, accountId, 'CodeBuddyIDE');
            if (!fs.existsSync(codeBuddyDir)) continue;

            const uidDirs = fs.readdirSync(codeBuddyDir, { withFileTypes: true })
                .filter(d => d.isDirectory()).map(d => d.name);

            for (const uid of uidDirs) {
                const historyPath = path.join(codeBuddyDir, uid, 'history');
                if (!fs.existsSync(historyPath)) continue;

                const workspaceDirs = fs.readdirSync(historyPath, { withFileTypes: true })
                    .filter(d => d.isDirectory()).map(d => d.name);

                for (const workspaceHash of workspaceDirs) {
                    // 是否属于当前工作区（用于活跃会话候选过滤）
                    const isCurrentWs = !filterHashes || filterHashes.includes(workspaceHash);

                    const workspacePath = path.join(historyPath, workspaceHash);
                    let sessionDirs: string[];
                    try {
                        sessionDirs = fs.readdirSync(workspacePath, { withFileTypes: true })
                            .filter(d => d.isDirectory()).map(d => d.name);
                    } catch { continue; }

                    for (const sessionDir of sessionDirs) {
                        const chatId = `${workspaceHash}/${sessionDir}`;
                        seenChatIds.add(chatId);
                        const indexPath = path.join(workspacePath, sessionDir, 'index.json');

                        if (!fs.existsSync(indexPath)) continue;

                        try {
                            const stat = fs.statSync(indexPath);
                            const cached = statusMtimeCache.get(chatId);
                            let status: string;

                            // mtime 未变则使用缓存
                            if (cached && cached.mtimeMs === stat.mtimeMs) {
                                status = cached.status;
                            } else {
                                // mtime 变化（含首次扫描）→ 标记本轮内容有变化，
                                // 用于触发上层 history list 刷新（让新消息能进入 webview）
                                if (cached) {
                                    contentChanged = true;
                                }
                                const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                                const requests = indexData.requests || [];
                                status = 'idle';
                                if (requests.length > 0) {
                                    const lastReq = requests[requests.length - 1];
                                    const reqState = lastReq.state;
                                    // 真实取值：'running' / 'complete' / 'active' / 'pending' / 'error'
                                    // 'running' / 'active' 表示正在执行；'pending' 单独一档（等待中）
                                    if (reqState === 'running' || reqState === 'active') {
                                        status = 'running';
                                    } else if (reqState === 'pending') {
                                        status = 'pending';
                                    } else if (reqState === 'complete' || reqState === 'completed') {
                                        status = 'completed';
                                    } else if (reqState === 'error' || reqState === 'failed') {
                                        status = 'error';
                                    }
                                }
                                statusMtimeCache.set(chatId, { status, mtimeMs: stat.mtimeMs });
                            }

                            statusMap[chatId] = status;

                            // 活跃会话候选：仅当该 workspaceHash 属于当前工作区时才参与评分
                            if (isCurrentWs) {
                                if (status === 'running') {
                                    bestActiveDir = sessionDir;
                                    bestActiveScore = 1000;
                                } else if (bestActiveScore < 1000) {
                                    const age = now - stat.mtimeMs;
                                    // 24 小时内的最近修改视为活跃兜底
                                    if (age < 24 * 60 * 60 * 1000 && stat.mtimeMs > bestActiveScore) {
                                        bestActiveDir = sessionDir;
                                        bestActiveScore = stat.mtimeMs;
                                    }
                                }
                            }
                        } catch { /* ignore individual session errors */ }
                    }
                }
            }
        }
    } catch (error) {
        log(`文件系统扫描失败: ${error}`);
    }

    // 清理已删除会话的缓存
    for (const chatId of statusMtimeCache.keys()) {
        if (!seenChatIds.has(chatId)) {
            statusMtimeCache.delete(chatId);
        }
    }

    return { activeSessionId: bestActiveDir, statusMap, contentChanged };
}

/**
 * 获取状态显示文本
 */
export function getStatusText(status: string): string {
    const map: Record<string, string> = {
        'idle': '空闲',
        'running': '执行中',
        'error': '错误',
        'completed': '已完成',
        'pending': '等待中',
        'active': '当前会话'
    };
    return map[status] || status;
}

/**
 * 获取状态 CSS 类名
 */
export function getStatusClass(status: string): string {
    const map: Record<string, string> = {
        'idle': 'status-idle',
        'running': 'status-running',
        'error': 'status-error',
        'completed': 'status-completed',
        'pending': 'status-pending',
        'active': 'status-active'
    };
    return map[status] || 'status-unknown';
}
