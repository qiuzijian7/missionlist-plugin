import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SidebarProvider } from './sidebarProvider';

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
 * 启动宽限期：扩展激活后的最初一段时间内，**不允许** mtime 兜底来选 active。
 *
 * 背景：IDE 刚启动时，CodeBuddy 聊天框真正打开的会话不一定是 history/<id>/index.json
 * mtime 最大的那个——例如：
 *   - 聊天框打开的是一个**新建空会话**，其 index.json 刚被 touch，mtime 反而落后于
 *     "上次用过的旧会话"（旧会话最后一次写入的 mtime 更晚）。
 *   - 聊天框打开的是一个旧会话，但插件启动期间另一个会话被后台 automation 触发写过。
 *
 * workbuddy.db 中并不存在"当前激活 session"这种状态字段（已通过 schema 确认），
 * 因此插件没有可靠途径在启动瞬间识别聊天框打开的会话。最稳妥的做法：
 *   - 启动初期只接受 fs 中真正出现 `running` 状态的会话作为 active；
 *   - 没有 running 时**不下发 active**（webview 端会清掉错位高亮）；
 *   - 等用户在插件里点击切换、或在 IDE 聊天框真正发消息触发 running 后再绑定。
 * 宽限期过后再回归 mtime 兜底，避免长时间无 active 影响日常使用。
 */
const STARTUP_GRACE_MS = 8 * 1000;
const monitorStartedAt: number = Date.now();

/**
 * mtime 兜底窗口：只有最近 30 分钟内修改过的会话才作为兜底候选。
 * 原先放的是 24 小时——冷启动时容易把"昨天最后用的会话"错误高亮，
 * 缩到 30 分钟可以显著减少误判。
 */
const MTIME_FALLBACK_WINDOW_MS = 30 * 60 * 1000;

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

        // 2. 决定最终活跃会话（优先级 高 → 低）：
        //    a. fs 检测到 running 状态的会话（实时反映正在执行）—— 任何时候都最高优先级
        //    b. 手动声明的会话（用户刚在插件里点击切换）
        //    c. fs mtime 兜底候选（仅最近 30 分钟内修改过的）
        //    特殊：启动宽限期内（首 STARTUP_GRACE_MS 毫秒）禁用 c，避免冷启动 mtime 错位
        let activeSessionId: string | null = null;

        // a) fs 扫描到的 running 会话（fsResult.runningSessionId 仅在确实有 running 时非空）
        if (fsResult.runningSessionId) {
            activeSessionId = fsResult.runningSessionId;
        }

        // b) 手动声明（仅当 a 未命中）
        if (!activeSessionId) {
            const manualValid =
                manualActiveSessionDir &&
                (Date.now() - manualActiveSetAt) < MANUAL_ACTIVE_TTL_MS;
            if (manualValid) {
                // 校验手动声明的 sessionDir 仍属于当前工作区且存在
                const manualChatId = Object.keys(fsResult.statusMap).find(
                    id => id.endsWith('/' + manualActiveSessionDir!)
                );
                if (manualChatId) {
                    activeSessionId = manualActiveSessionDir;
                } else {
                    // 已不在当前工作区列表中，丢弃手动值
                    manualActiveSessionDir = null;
                }
            }
        }

        // c) mtime 兜底（仅在启动宽限期之外才启用）
        if (!activeSessionId) {
            const sinceStart = Date.now() - monitorStartedAt;
            if (sinceStart >= STARTUP_GRACE_MS) {
                activeSessionId = fsResult.fallbackSessionId;
            } else if (fsResult.fallbackSessionId && lastActiveSessionId === null) {
                // 启动宽限期内仅记录日志，不下发兜底 active
                log(`[启动宽限期] 跳过 mtime 兜底候选: ${fsResult.fallbackSessionId} (剩余 ${STARTUP_GRACE_MS - sinceStart}ms)`);
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

interface FileScanResult {
    /**
     * 当前是否有 running 状态的会话；有则其 sessionDir，否则 null。
     * 这是"实时活跃"的最强信号，由 updateChatStatus 优先采用。
     */
    runningSessionId: string | null;
    /**
     * mtime 兜底候选 sessionDir：当前工作区下最近 30 分钟内 mtime 最大的非 running 会话。
     * 仅在没有 running 且过了启动宽限期后由 updateChatStatus 启用。
     */
    fallbackSessionId: string | null;
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
    // running 候选：当前工作区内任意 status==='running' 的 sessionDir（最先命中即可）
    let runningSessionId: string | null = null;
    // mtime 兜底候选：当前工作区内最近 MTIME_FALLBACK_WINDOW_MS 内 mtime 最大的 sessionDir
    let fallbackDir: string | null = null;
    let fallbackMtime = -1;

    const statusMap: Record<string, string> = {};
    const now = Date.now();
    const seenChatIds = new Set<string>();
    let contentChanged = false;

    const dataRoot = path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data');
    if (!fs.existsSync(dataRoot)) {
        return { runningSessionId: null, fallbackSessionId: null, statusMap, contentChanged };
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
                                // mtime 变化或首次发现新会话 → 标记本轮内容有变化，
                                // 用于触发上层 history list 刷新（让新消息能进入 webview）
                                // 注意：首次发现新会话（cached 为 undefined）也要标记，
                                // 否则新建聊天会话不会出现在历史列表中
                                contentChanged = true;
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

                            // 活跃会话候选：仅当该 workspaceHash 属于当前工作区时才参与
                            if (isCurrentWs) {
                                if (status === 'running' && !runningSessionId) {
                                    runningSessionId = sessionDir;
                                }
                                // mtime 兜底：仅最近 MTIME_FALLBACK_WINDOW_MS 内的会话才参选
                                const age = now - stat.mtimeMs;
                                if (age < MTIME_FALLBACK_WINDOW_MS && stat.mtimeMs > fallbackMtime) {
                                    fallbackDir = sessionDir;
                                    fallbackMtime = stat.mtimeMs;
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

    return {
        runningSessionId,
        fallbackSessionId: fallbackDir,
        statusMap,
        contentChanged
    };
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
