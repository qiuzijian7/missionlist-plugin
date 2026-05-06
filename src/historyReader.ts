import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as cp from 'child_process';

export type ChatStatus = 'idle' | 'running' | 'error' | 'completed' | 'pending';

export interface ChatHistory {
    id: string;
    title: string;
    preview: string;
    timestamp: number;
    status?: ChatStatus;
    messages?: ChatMessage[];
    /** 工作区哈希，用于定位文件系统路径 */
    workspaceHash?: string;
    /** 会话目录名（时间戳或 UUID） */
    sessionDir?: string;
    /** 原始工作区路径（如果能反查到） */
    workspacePath?: string;
    /** 数据库中的 session ID（UUID 格式，用于 deep link 导航） */
    sessionId?: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
}

/**
 * 获取 CodeBuddyExtension 数据根目录
 */
function getDataRoot(): string {
    return path.join(
        os.homedir(),
        'AppData',
        'Local',
        'CodeBuddyExtension',
        'Data'
    );
}

/**
 * 自动发现所有账户下的 history 目录
 * CodeBuddyExtension 的目录结构为: Data/{userId}/CodeBuddyIDE/{uid}/history/
 * 也兼容旧结构: Data/default/CodeBuddyIDE/history/
 */
function discoverHistoryRoots(): string[] {
    const dataRoot = getDataRoot();
    const roots: string[] = [];

    if (!fs.existsSync(dataRoot)) {
        return roots;
    }

    const accountDirs = fs.readdirSync(dataRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const accountId of accountDirs) {
        const accountPath = path.join(dataRoot, accountId);

        // 新结构: Data/{userId}/CodeBuddyIDE/{uid}/history/
        const codeBuddyDir = path.join(accountPath, 'CodeBuddyIDE');
        if (fs.existsSync(codeBuddyDir)) {
            const uidDirs = fs.readdirSync(codeBuddyDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            for (const uid of uidDirs) {
                const historyPath = path.join(codeBuddyDir, uid, 'history');
                if (fs.existsSync(historyPath)) {
                    roots.push(historyPath);
                }
            }
        }
    }

    return roots;
}

/**
 * 计算工作区路径的 MD5 哈希
 * 算法与 CodeBuddyExtension 一致: MD5(path.normalize(workspacePath))
 */
export function computeWorkspaceHash(workspacePath: string): string {
    const normalized = path.normalize(workspacePath);
    return crypto.createHash('md5').update(normalized).digest('hex');
}

/**
 * 为 Windows 路径生成候选哈希列表（大小写盘符都尝试）
 */
function getCandidateHashes(workspacePath: string): string[] {
    const normalized = path.normalize(workspacePath);
    const hashes = [computeWorkspaceHash(normalized)];

    if (process.platform === 'win32' && /^[a-zA-Z]:/.test(normalized)) {
        const flipped = normalized[0] === normalized[0].toLowerCase()
            ? normalized[0].toUpperCase() + normalized.slice(1)
            : normalized[0].toLowerCase() + normalized.slice(1);
        const flippedHash = computeWorkspaceHash(flipped);
        if (flippedHash !== hashes[0]) {
            hashes.push(flippedHash);
        }
    }

    return hashes;
}

/**
 * 从 WorkBuddy SQLite 数据库读取会话标题
 * 数据库路径: ~/.workbuddy/workbuddy.db
 * 表: sessions (id, title, custom_title, cwd, ...)
 */
interface SessionTitleInfo {
    title: string;
    customTitle: string | null;
    cwd: string;
    /** 数据库中的 session ID（UUID 格式） */
    sessionId: string;
}

/** 数据库 session 信息，按 cwd 索引 */
interface SessionDBCache {
    /** sessionId (带连字符 UUID) → SessionTitleInfo */
    byId: Map<string, SessionTitleInfo>;
    /** sessionId 去掉连字符 (32位hex) → SessionTitleInfo */
    byIdNoHyphen: Map<string, SessionTitleInfo>;
    /** cwd (normalized lower) → SessionTitleInfo[] */
    byCwd: Map<string, SessionTitleInfo[]>;
}

function readSessionTitlesFromDB(): SessionDBCache {
    const byId = new Map<string, SessionTitleInfo>();
    const byIdNoHyphen = new Map<string, SessionTitleInfo>();
    const byCwd = new Map<string, SessionTitleInfo[]>();
    const dbPath = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');

    if (!fs.existsSync(dbPath)) {
        return { byId, byIdNoHyphen, byCwd };
    }

    try {
        const query = `SELECT id, title, custom_title, cwd FROM sessions WHERE deleted_at IS NULL`;
        const result = cp.execSync(`sqlite3 "${dbPath}" "${query}"`, {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true
        });

        for (const line of result.trim().split('\n')) {
            if (!line) { continue; }
            const parts = line.split('|');
            if (parts.length >= 4) {
                const sessionId = parts[0];
                const title = parts[1] || '';
                const customTitle = parts[2] || null;
                const cwd = parts.slice(3).join('|');
                const info: SessionTitleInfo = { title, customTitle, cwd, sessionId };
                byId.set(sessionId, info);
                // 同时用去掉连字符的 ID 建索引（文件系统目录名是不带连字符的 UUID）
                const noHyphenId = sessionId.replace(/-/g, '');
                byIdNoHyphen.set(noHyphenId, info);
                const cwdKey = path.normalize(cwd).toLowerCase();
                const arr = byCwd.get(cwdKey) || [];
                arr.push(info);
                byCwd.set(cwdKey, arr);
            }
        }
    } catch {
        // sqlite3 命令不可用，静默失败
    }

    return { byId, byIdNoHyphen, byCwd };
}

/**
 * 使用与 CodeBuddy 一致的算法生成标题
 * 算法: trim + 压缩空白 + 截断50字符 + "..."
 */
function buildSessionTitle(inboundText: string): string {
    const title = inboundText.trim().replace(/\s+/g, ' ');
    if (!title) { return 'Claw Message'; }
    return title.length > 50 ? `${title.slice(0, 50)}...` : title;
}

/**
 * 从消息的 message 字段解析出纯文本内容
 */
function extractMessageContent(rawMessage: string): string {
    try {
        const parsed = JSON.parse(rawMessage);
        if (typeof parsed === 'string') {
            return parsed;
        }
        if (parsed && typeof parsed.content === 'string') {
            return parsed.content;
        }
        if (parsed && Array.isArray(parsed.content)) {
            return parsed.content
                .map((item: any) => {
                    if (typeof item === 'string') return item;
                    if (item && item.text) return item.text;
                    if (item && item.result) {
                        try {
                            const r = typeof item.result === 'string' ? JSON.parse(item.result) : item.result;
                            if (r && r.content) return r.content;
                        } catch { /* ignore */ }
                    }
                    return '';
                })
                .filter((s: string) => s.length > 0)
                .join('\n')
                .substring(0, 200);
        }
        return rawMessage.substring(0, 200);
    } catch {
        return rawMessage.substring(0, 200);
    }
}

/**
 * 从 historyRoot 读取单个目录下的会话列表
 */
function readSessionsFromRoot(
    historyRoot: string,
    filterHashes?: string[]
): ChatHistory[] {
    const results: ChatHistory[] = [];

    if (!fs.existsSync(historyRoot)) {
        return results;
    }

    // 从数据库读取所有会话信息
    const dbCache = readSessionTitlesFromDB();

    // 建立 workspaceHash → cwd 的反向映射
    // workspaceHash = MD5(normalize(cwd))，遍历数据库中的 cwd 计算哈希
    const hashToCwd = new Map<string, string>();
    for (const [cwdKey, sessions] of dbCache.byCwd) {
        for (const session of sessions) {
            const hash = computeWorkspaceHash(session.cwd);
            hashToCwd.set(hash, session.cwd);
            // 也尝试大小写翻转的哈希
            const flippedCwd = process.platform === 'win32' && /^[a-zA-Z]:/.test(session.cwd)
                ? (session.cwd[0] === session.cwd[0].toLowerCase()
                    ? session.cwd[0].toUpperCase() + session.cwd.slice(1)
                    : session.cwd[0].toLowerCase() + session.cwd.slice(1))
                : null;
            if (flippedCwd) {
                const flippedHash = computeWorkspaceHash(flippedCwd);
                if (flippedHash !== hash) {
                    hashToCwd.set(flippedHash, session.cwd);
                }
            }
        }
    }

    // 建立 cwd → sessionId[] 的映射（按 updated_at DESC，取最新的）
    const cwdToSessionId = new Map<string, string>();
    for (const [cwdKey, sessions] of dbCache.byCwd) {
        // sessions 已按数据库查询顺序（无序），按需要可排序
        // 每个 cwd 下可能有多个 session，后续按 sessionDir 时间戳匹配
    }

    const workspaceDirs = fs.readdirSync(historyRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const workspaceHash of workspaceDirs) {
        if (filterHashes && !filterHashes.includes(workspaceHash)) {
            continue;
        }

        const workspacePath = path.join(historyRoot, workspaceHash);
        // 通过 hash 反查 cwd
        const cwdForHash = hashToCwd.get(workspaceHash);
        // 获取该 cwd 下的所有数据库 sessions
        const dbSessionsForCwd = cwdForHash
            ? (dbCache.byCwd.get(path.normalize(cwdForHash).toLowerCase()) || [])
            : [];

        // 读取工作区级别的 index.json 获取 conversations 列表
        // 这里的 name 字段就是 CodeBuddy IDE 中实际显示的对话标题
        const wsIndexPath = path.join(workspacePath, 'index.json');
        const conversationNames = new Map<string, string>();
        const conversationMeta = new Map<string, { name?: string; lastMessageAt?: string; createdAt?: string }>();
        if (fs.existsSync(wsIndexPath)) {
            try {
                const wsIndex = JSON.parse(fs.readFileSync(wsIndexPath, 'utf-8'));
                const conversations = wsIndex.conversations || [];
                for (const conv of conversations) {
                    if (conv.id) {
                        if (conv.name) {
                            conversationNames.set(conv.id, conv.name);
                        }
                        conversationMeta.set(conv.id, {
                            name: conv.name,
                            lastMessageAt: conv.lastMessageAt,
                            createdAt: conv.createdAt
                        });
                    }
                }
            } catch { /* ignore parse errors */ }
        }

        const sessionDirs = fs.readdirSync(workspacePath, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        for (const sessionDir of sessionDirs) {
            try {
                const indexPath = path.join(workspacePath, sessionDir, 'index.json');
                if (!fs.existsSync(indexPath)) {
                    continue;
                }

                const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                const messages = indexData.messages || [];

                let matchedDbSession: SessionTitleInfo | undefined;
                let title = '未命名对话';
                let preview = '';
                let sessionId: string | undefined;

                // 优先级1: 从工作区 index.json 的 conversations[].name 读取标题
                // 这是 CodeBuddy IDE 中实际显示的对话名称
                const convName = conversationNames.get(sessionDir);
                if (convName) {
                    title = convName;
                }

                // 尝试从数据库匹配（用于获取 sessionId 等额外信息）
                // 文件系统目录名是不带连字符的 UUID，优先用 byIdNoHyphen 匹配
                matchedDbSession = dbCache.byIdNoHyphen.get(sessionDir);
                // 也尝试带连字符的格式（兼容旧版本）
                if (!matchedDbSession) {
                    matchedDbSession = dbCache.byId.get(sessionDir);
                }

                // 如果没找到，尝试用时间戳匹配
                if (!matchedDbSession && dbSessionsForCwd.length > 0) {
                    const indexTimestamp = /^\d+$/.test(sessionDir) ? parseInt(sessionDir, 10) : 0;
                    // 在同 cwd 的 sessions 中找 created_at 最接近的
                    let bestMatch: SessionTitleInfo | undefined;
                    let bestDiff = Infinity;
                    for (const dbSession of dbSessionsForCwd) {
                        // 从 index.json 的 requests 中提取时间戳
                        const requests = indexData.requests || [];
                        if (requests.length > 0 && requests[0].createdAt) {
                            const diff = Math.abs(requests[0].createdAt - (dbSession as any).created_at);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestMatch = dbSession;
                            }
                        }
                    }
                    if (bestMatch && bestDiff < 60000) { // 60秒内视为匹配
                        matchedDbSession = bestMatch;
                    }
                }

                if (matchedDbSession) {
                    // 优先级2: 数据库 custom_title（仅在工作区 index.json 中没找到时使用）
                    if (!convName) {
                        title = matchedDbSession.customTitle || matchedDbSession.title || '未命名对话';
                    }
                    sessionId = matchedDbSession.sessionId;
                }

                // 读取第一条用户消息作为 preview 和标题回退
                let firstUserContent = '';
                let firstUserMsgId: string | null = null;

                for (const msg of messages) {
                    if (msg.role === 'user') {
                        firstUserMsgId = msg.id;
                        break;
                    }
                }

                if (firstUserMsgId) {
                    const msgFilePath = path.join(workspacePath, sessionDir, 'messages', `${firstUserMsgId}.json`);
                    if (fs.existsSync(msgFilePath)) {
                        try {
                            const msgData = JSON.parse(fs.readFileSync(msgFilePath, 'utf-8'));
                            firstUserContent = extractMessageContent(msgData.message || '');
                            preview = firstUserContent.substring(0, 150).replace(/\n/g, ' ');
                        } catch { /* ignore parse errors */ }
                    }
                }

                if (!matchedDbSession && !convName && firstUserContent) {
                    title = buildSessionTitle(firstUserContent);
                }

                // 获取时间戳：优先从工作区 index.json 的 conversations 中获取
                let timestamp: number;
                const convMeta = conversationMeta.get(sessionDir);
                
                if (convMeta && convMeta.lastMessageAt) {
                    timestamp = new Date(convMeta.lastMessageAt).getTime();
                } else if (convMeta && convMeta.createdAt) {
                    timestamp = new Date(convMeta.createdAt).getTime();
                } else if (/^\d+$/.test(sessionDir)) {
                    timestamp = parseInt(sessionDir, 10);
                } else {
                    // 使用文件的修改时间作为最后手段
                    try {
                        const stat = fs.statSync(path.join(workspacePath, sessionDir));
                        timestamp = stat.mtimeMs;
                    } catch {
                        timestamp = Date.now();
                    }
                }

                const userMsgCount = messages.filter((m: any) => m.role === 'user').length;

                const requests = indexData.requests || [];
                let status: ChatStatus = 'idle';
                if (requests.length > 0) {
                    const lastRequest = requests[requests.length - 1];
                    if (lastRequest.state === 'active') {
                        status = 'running';
                    } else if (lastRequest.state === 'complete') {
                        status = 'completed';
                    }
                }

                results.push({
                    id: `${workspaceHash}/${sessionDir}`,
                    title,
                    preview: preview || '无预览',
                    timestamp,
                    status,
                    workspaceHash,
                    sessionDir,
                    sessionId,
                    workspacePath: cwdForHash,
                    messages: new Array(userMsgCount).fill(null)
                });
            } catch (e) {
                console.error(`读取会话 ${workspaceHash}/${sessionDir} 失败:`, e);
            }
        }
    }

    return results;
}

/**
 * 查找包含指定 workspaceHash 的 historyRoot 路径
 */
function findHistoryRootForHash(workspaceHash: string): string | null {
    const roots = discoverHistoryRoots();
    for (const root of roots) {
        const target = path.join(root, workspaceHash);
        if (fs.existsSync(target)) {
            return root;
        }
    }
    return null;
}

/**
 * 读取 CodeBuddyExtension 历史聊天记录
 * @param currentWorkspacePath 当前 VS Code 工作区路径，传入则只返回该工作区的聊天记录
 */
export async function readCodeBuddyHistory(currentWorkspacePath?: string): Promise<ChatHistory[]> {
    const history: ChatHistory[] = [];

    try {
        const roots = discoverHistoryRoots();

        if (roots.length === 0) {
            console.log('未找到 CodeBuddyExtension 历史记录目录');
            return history;
        }

        // 计算当前工作区的候选哈希
        const filterHashes = currentWorkspacePath ? getCandidateHashes(currentWorkspacePath) : undefined;

        for (const root of roots) {
            const sessions = readSessionsFromRoot(root, filterHashes);
            history.push(...sessions);
        }

    } catch (error) {
        console.error('读取 CodeBuddyExtension 历史记录失败:', error);
        vscode.window.showErrorMessage(`无法读取历史记录: ${error}`);
    }

    // 尝试应用保存的自定义排序
    const customOrder = readHistoryOrder();
    if (customOrder.length > 0) {
        // 创建一个映射：chatId -> ChatHistory
        const historyMap = new Map<string, ChatHistory>();
        for (const chat of history) {
            historyMap.set(chat.id, chat);
        }

        // 按保存的顺序重新排序
        const orderedHistory: ChatHistory[] = [];
        for (const id of customOrder) {
            const chat = historyMap.get(id);
            if (chat) {
                orderedHistory.push(chat);
                historyMap.delete(id);
            }
        }

        // 将不在自定义顺序中的聊天记录追加到末尾
        for (const [id, chat] of historyMap) {
            orderedHistory.push(chat);
        }

        return orderedHistory;
    }

    // 如果没有自定义排序，按时间降序排列
    return history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * 读取单个聊天记录的完整详情（包括消息历史）
 * @param chatId 格式为 "workspaceHash/sessionDir"
 */
export async function readChatDetail(chatId: string): Promise<ChatHistory | null> {
    try {
        const [workspaceHash, sessionDir] = chatId.split('/');
        if (!workspaceHash || !sessionDir) {
            console.error('无效的 chatId 格式:', chatId);
            return null;
        }

        // 在所有 historyRoot 中查找
        const historyRoot = findHistoryRootForHash(workspaceHash);
        if (!historyRoot) {
            console.error('未找到工作区哈希对应的目录:', workspaceHash);
            return null;
        }

        const sessionPath = path.join(historyRoot, workspaceHash, sessionDir);
        const indexPath = path.join(sessionPath, 'index.json');

        if (!fs.existsSync(indexPath)) {
            console.error('会话索引文件不存在:', indexPath);
            return null;
        }

        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const indexMessages = indexData.messages || [];

        const chatMessages: ChatMessage[] = [];
        const messagesDir = path.join(sessionPath, 'messages');

        for (const msgRef of indexMessages) {
            const msgFilePath = path.join(messagesDir, `${msgRef.id}.json`);
            if (!fs.existsSync(msgFilePath)) {
                continue;
            }

            try {
                const msgData = JSON.parse(fs.readFileSync(msgFilePath, 'utf-8'));
                const content = extractMessageContent(msgData.message || '');
                const timestamp = /^\d+$/.test(sessionDir) ? parseInt(sessionDir, 10) : Date.now();

                chatMessages.push({
                    role: msgData.role || msgRef.role,
                    content,
                    timestamp
                });
            } catch { /* ignore individual message errors */ }
        }

        let title = '未命名对话';
        let sessionId: string | undefined;

        // 优先级1: 从工作区 index.json 的 conversations[].name 读取标题
        // 这是 CodeBuddy IDE 中实际显示的对话名称
        const wsIndexPath = path.join(historyRoot, workspaceHash, 'index.json');
        let convName: string | undefined;
        let convLastMessageAt: string | undefined;
        if (fs.existsSync(wsIndexPath)) {
            try {
                const wsIndex = JSON.parse(fs.readFileSync(wsIndexPath, 'utf-8'));
                const conv = (wsIndex.conversations || []).find((c: any) => c.id === sessionDir);
                if (conv && conv.name) {
                    convName = conv.name;
                    title = conv.name;
                }
                if (conv && conv.lastMessageAt) {
                    convLastMessageAt = conv.lastMessageAt;
                }
            } catch { /* ignore */ }
        }

        // 优先级2: 从数据库读取标题（仅在没有 convName 时）
        const dbCache = readSessionTitlesFromDB();
        const dbInfo = dbCache.byIdNoHyphen.get(sessionDir) || dbCache.byId.get(sessionDir);
        if (dbInfo) {
            if (!convName) {
                title = dbInfo.customTitle || dbInfo.title || '未命名对话';
            }
            sessionId = dbInfo.sessionId;
        }
        // 优先级3: 使用与 CodeBuddy 一致的算法从第一条用户消息生成标题
        if (!convName && !dbInfo) {
            const firstUserMsg = chatMessages.find(m => m.role === 'user');
            if (firstUserMsg) {
                title = buildSessionTitle(firstUserMsg.content);
            }
        }

        // 获取时间戳
        let timestamp: number;
        if (convLastMessageAt) {
            timestamp = new Date(convLastMessageAt).getTime();
        } else if (/^\d+$/.test(sessionDir)) {
            timestamp = parseInt(sessionDir, 10);
        } else {
            try {
                const stat = fs.statSync(sessionPath);
                timestamp = stat.mtimeMs;
            } catch {
                timestamp = Date.now();
            }
        }

        const firstUserMsg = chatMessages.find(m => m.role === 'user');
        const preview = firstUserMsg ? firstUserMsg.content.substring(0, 150).replace(/\n/g, ' ') : '';

        return {
            id: chatId,
            title,
            preview,
            timestamp,
            workspaceHash,
            sessionDir,
            sessionId,
            messages: chatMessages
        };
    } catch (error) {
        console.error('读取聊天详情失败:', error);
        return null;
    }
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(timestamp: number): string {
    if (!timestamp) return '未知时间';

    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;

    return date.toLocaleDateString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * 重命名聊天记录
 */
export async function renameChatHistory(chatId: string, newTitle: string): Promise<boolean> {
    try {
        const [workspaceHash, sessionDir] = chatId.split('/');
        if (!workspaceHash || !sessionDir) {
            return false;
        }

        const historyRoot = findHistoryRootForHash(workspaceHash);
        if (!historyRoot) {
            return false;
        }

        const sessionPath = path.join(historyRoot, workspaceHash, sessionDir);
        if (!fs.existsSync(sessionPath)) {
            return false;
        }

        const titleFilePath = path.join(sessionPath, 'title.txt');
        fs.writeFileSync(titleFilePath, newTitle, 'utf-8');
        return true;
    } catch (error) {
        console.error('重命名聊天记录失败:', error);
        return false;
    }
}

/**
 * 读取自定义标题（如果存在）
 */
export function readCustomTitle(workspaceHash: string, sessionDir: string): string | null {
    try {
        const historyRoot = findHistoryRootForHash(workspaceHash);
        if (!historyRoot) {
            return null;
        }
        const titleFilePath = path.join(historyRoot, workspaceHash, sessionDir, 'title.txt');
        if (fs.existsSync(titleFilePath)) {
            return fs.readFileSync(titleFilePath, 'utf-8').trim();
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * 删除聊天记录
 * @param chatId 格式为 "workspaceHash/sessionDir"
 */
export async function deleteChatHistory(chatId: string): Promise<boolean> {
    try {
        const [workspaceHash, sessionDir] = chatId.split('/');
        if (!workspaceHash || !sessionDir) {
            return false;
        }

        const historyRoot = findHistoryRootForHash(workspaceHash);
        if (!historyRoot) {
            return false;
        }

        const sessionPath = path.join(historyRoot, workspaceHash, sessionDir);
        if (!fs.existsSync(sessionPath)) {
            console.error('未找到要删除的聊天记录:', chatId);
            return false;
        }

        fs.rmSync(sessionPath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error('删除聊天记录失败:', error);
        return false;
    }
}

/**
 * 保存历史记录的新排序顺序
 * 将排序后的 ID 列表保存到一个配置文件中
 * @param orderedIds 按新顺序排列的聊天 ID 列表
 */
export async function saveHistoryOrder(orderedIds: string[]): Promise<boolean> {
    try {
        // 保存到用户主目录的 .codebuddy 目录
        const orderFilePath = path.join(os.homedir(), '.codebuddy', 'history-order.json');
        
        // 确保目录存在
        const dirPath = path.dirname(orderFilePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // 写入排序顺序
        fs.writeFileSync(
            orderFilePath, 
            JSON.stringify({ order: orderedIds, updatedAt: Date.now() }, null, 2), 
            'utf-8'
        );
        
        return true;
    } catch (error) {
        console.error('保存历史记录排序失败:', error);
        return false;
    }
}

/**
 * 读取历史记录的排序顺序
 * @returns 排序后的聊天 ID 列表，如果不存在则返回空数组
 */
export function readHistoryOrder(): string[] {
    try {
        const orderFilePath = path.join(os.homedir(), '.codebuddy', 'history-order.json');
        
        if (!fs.existsSync(orderFilePath)) {
            return [];
        }
        
        const data = JSON.parse(fs.readFileSync(orderFilePath, 'utf-8'));
        return data.order || [];
    } catch (error) {
        console.error('读取历史记录排序失败:', error);
        return [];
    }
}
