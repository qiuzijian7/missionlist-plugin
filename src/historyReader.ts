import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { querySqlite, getWorkBuddyDbPath } from './db';

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
export function getCandidateHashes(workspacePath: string): string[] {
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

async function readSessionTitlesFromDB(): Promise<SessionDBCache> {
    const byId = new Map<string, SessionTitleInfo>();
    const byIdNoHyphen = new Map<string, SessionTitleInfo>();
    const byCwd = new Map<string, SessionTitleInfo[]>();
    const dbPath = getWorkBuddyDbPath();

    if (!fs.existsSync(dbPath)) {
        return { byId, byIdNoHyphen, byCwd };
    }

    try {
        const results = await querySqlite(
            dbPath,
            `SELECT id, title, custom_title, cwd FROM sessions WHERE deleted_at IS NULL`
        );

        if (results.length > 0) {
            const { columns, values } = results[0];
            const idIdx = columns.indexOf('id');
            const titleIdx = columns.indexOf('title');
            const customTitleIdx = columns.indexOf('custom_title');
            const cwdIdx = columns.indexOf('cwd');

            for (const row of values) {
                const sessionId = String(row[idIdx] || '');
                const title = String(row[titleIdx] || '');
                const customTitle = row[customTitleIdx] != null ? String(row[customTitleIdx]) : null;
                const cwd = String(row[cwdIdx] || '');

                if (!sessionId) { continue; }
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
    } catch (error) {
        console.error('[HistoryViewer] readSessionTitlesFromDB failed:', error);
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
 * 从文本中提取 <user_query> 标签内的内容（仅取"当前轮"的真实用户输入）
 *
 * 重要背景 — CodeBuddy 在多轮对话中会把上一轮的对话上下文重新拼接进当前轮的
 * user message body。具体结构通常是：
 *
 *   <整段 user message>
 *   ├─ <cb_summary>
 *   │    ... <previous_user_message>、<previous_assistant_message>、
 *   │        <previous_tool_call> ... 这些历史段落里 **频繁引用 <user_query>
 *   │        字面文字**（既包含上一轮的真实 query，也包含 assistant 解释代码
 *   │        时贴的源码字符串、工具调用 old_str 参数中的源码等）
 *   │  </cb_summary>
 *   │
 *   ├─ <additional_data> ...
 *   │
 *   └─ <user_query>本轮真正的用户输入</user_query>   ← 真实输入永远在最末尾
 *
 * 因此提取顺序：
 *   1. 优先从 `</cb_summary>` 之后的"当前轮区域"找 `<user_query>`；
 *   2. 若没有 `</cb_summary>`（首轮对话），退化为整段文本；
 *   3. 取该区域中 **最后一个** `<user_query>` 匹配（额外的稳健保护）；
 *   4. 都没找到则返回 null（保持原行为）。
 *
 * 这样能正确处理两种情况：
 *   - 首轮：整段只有一个 user_query → 拿到它本身。
 *   - 多轮（被 cb_summary 包裹）：忽略 summary 内所有引用，只拿当前真实输入。
 */
function extractUserQueryContent(text: string): string | null {
    if (!text) { return null; }

    // 1) 切到 </cb_summary> 之后的区域
    const cbEndIdx = text.lastIndexOf('</cb_summary>');
    const region = cbEndIdx >= 0
        ? text.slice(cbEndIdx + '</cb_summary>'.length)
        : text;

    // 2) 取该区域内最后一个 <user_query>...</user_query>
    const re = /<user_query>([\s\S]*?)<\/user_query>/g;
    const matches = [...region.matchAll(re)];
    if (matches.length === 0) { return null; }
    return matches[matches.length - 1][1].trim();
}

/**
 * 从消息的 message 字段解析出纯文本内容
 */
function extractMessageContent(rawMessage: string, maxLength: number = 200): string {
    try {
        const parsed = JSON.parse(rawMessage);
        if (typeof parsed === 'string') {
            return maxLength < parsed.length ? parsed.substring(0, maxLength) : parsed;
        }
        if (parsed && typeof parsed.content === 'string') {
            const content = parsed.content;
            return maxLength < content.length ? content.substring(0, maxLength) : content;
        }
        if (parsed && Array.isArray(parsed.content)) {
            const joined = parsed.content
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
                .join('\n');
            return maxLength < joined.length ? joined.substring(0, maxLength) : joined;
        }
        return maxLength < rawMessage.length ? rawMessage.substring(0, maxLength) : rawMessage;
    } catch {
        return maxLength < rawMessage.length ? rawMessage.substring(0, maxLength) : rawMessage;
    }
}

/**
 * 从 historyRoot 读取单个目录下的会话列表
 */
async function readSessionsFromRoot(
    historyRoot: string,
    filterHashes?: string[]
): Promise<ChatHistory[]> {
    const results: ChatHistory[] = [];

    if (!fs.existsSync(historyRoot)) {
        return Promise.resolve(results);
    }

    // 从数据库读取所有会话信息
    const dbCache = await readSessionTitlesFromDB();

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

    console.log(`[HistoryViewer] ${historyRoot} 下的 workspaceDirs:`, workspaceDirs, 'filterHashes:', filterHashes);

    for (const workspaceHash of workspaceDirs) {
        if (filterHashes && !filterHashes.includes(workspaceHash)) {
            console.log(`[HistoryViewer] 跳过 workspaceHash ${workspaceHash}，不在 filterHashes 中`);
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

        console.log(`[HistoryViewer] workspace ${workspaceHash} 下的 sessionDirs:`, sessionDirs);

        for (const sessionDir of sessionDirs) {
            try {
                const indexPath = path.join(workspacePath, sessionDir, 'index.json');
                if (!fs.existsSync(indexPath)) {
                    console.log(`[HistoryViewer] 跳过 ${sessionDir}，index.json 不存在`);
                    continue;
                }

                const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                const messages = indexData.messages || [];

                let matchedDbSession: SessionTitleInfo | undefined;
                let title = '未命名对话';
                let preview = '';
                let sessionId: string | undefined;

                // 优先级0（最高）: 读取用户自定义的 title.txt（通过插件重命名功能保存）
                const customTitleFile = path.join(workspacePath, sessionDir, 'title.txt');
                let hasCustomTitle = false;
                if (fs.existsSync(customTitleFile)) {
                    try {
                        const customTitle = fs.readFileSync(customTitleFile, 'utf-8').trim();
                        if (customTitle) {
                            title = customTitle;
                            hasCustomTitle = true;
                        }
                    } catch { /* ignore */ }
                }

                // 优先级1: 从工作区 index.json 的 conversations[].name 读取标题
                // 这是 CodeBuddy IDE 中实际显示的对话名称
                const convName = conversationNames.get(sessionDir);
                if (!hasCustomTitle && convName) {
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
                    // 优先级2: 数据库 custom_title（仅在没有自定义标题且工作区 index.json 中没找到时使用）
                    if (!hasCustomTitle && !convName) {
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
                            // 先提取完整内容（不截断），确保 user_query 标签完整
                            const fullContent = extractMessageContent(msgData.message || '', Infinity);
                            // 优先使用 <user_query> 标签内的内容作为预览
                            const userQueryContent = extractUserQueryContent(fullContent);
                            firstUserContent = userQueryContent || fullContent;
                            preview = firstUserContent.substring(0, 150).replace(/\n/g, ' ');
                        } catch { /* ignore parse errors */ }
                    }
                }

                if (!hasCustomTitle && !matchedDbSession && !convName && firstUserContent) {
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
                    const reqState = lastRequest.state;
                    // 真实取值：'running' / 'complete' / 'active' / 'pending' / 'error'
                    if (reqState === 'running' || reqState === 'active' || reqState === 'pending') {
                        status = 'running';
                    } else if (reqState === 'complete' || reqState === 'completed') {
                        status = 'completed';
                    } else if (reqState === 'error' || reqState === 'failed') {
                        status = 'error';
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
            console.log('[HistoryViewer] 未找到 CodeBuddyExtension 历史记录目录');
            return history;
        }

        console.log('[HistoryViewer] 发现 history roots:', roots);

        // 计算当前工作区的候选哈希
        const filterHashes = currentWorkspacePath ? getCandidateHashes(currentWorkspacePath) : undefined;
        console.log('[HistoryViewer] 当前工作区:', currentWorkspacePath, '过滤哈希:', filterHashes);

        for (const root of roots) {
            const sessions = await readSessionsFromRoot(root, filterHashes);
            console.log(`[HistoryViewer] 从 ${root} 读取到 ${sessions.length} 个会话`);
            history.push(...sessions);
        }

    } catch (error) {
        console.error('读取 CodeBuddyExtension 历史记录失败:', error);
        vscode.window.showErrorMessage(`无法读取历史记录: ${error}`);
    }

    // 尝试应用保存的自定义排序（按工作区隔离）
    let customOrder: string[] = [];
    if (currentWorkspacePath) {
        const candidateHashes = getCandidateHashes(currentWorkspacePath);
        for (const hash of candidateHashes) {
            const order = readHistoryOrder(hash);
            if (order.length > 0) {
                customOrder = order;
                break;
            }
        }
    }
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

        // 将不在自定义顺序中的"新会话"按时间倒序插入到顶部，
        // 保证新创建的会话默认显示在顶部，方便用户快速访问
        const newcomers = Array.from(historyMap.values())
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        // 新会话插入到顶部（倒序遍历，使最新的在最前面）
        for (let i = newcomers.length - 1; i >= 0; i--) {
            orderedHistory.unshift(newcomers[i]);
        }

        // 关键：一旦出现新会话或 customOrder 中包含已不存在的 id，
        // 立即把当前显示顺序写回 history-order.json，让"新会话也被固化"。
        // 这样用户后续就再也不会看到任何"自动排序"行为——所有位置都是被记录的。
        const orderedIds = orderedHistory.map(c => c.id);
        const orderChanged =
            orderedIds.length !== customOrder.length ||
            orderedIds.some((id, i) => id !== customOrder[i]);
        if (orderChanged) {
            // fire-and-forget，写盘失败也不影响本次返回
            saveHistoryOrder(orderedIds).catch(err => {
                console.error('[HistoryViewer] 自动固化新会话顺序失败:', err);
            });
        }

        return orderedHistory;
    }

    // 没有自定义排序时（首次使用或 history-order.json 缺失）：
    // 1) 用"当前可见的会话集合"按时间降序生成一份初始快照（仅作为首屏展示）；
    // 2) 立刻（同步 await）把该快照写回 history-order.json，把每个 id 的位置固化下来。
    // 这样从下一次刷新起，就完全走上面的 customOrder 分支——
    // 任何会话被输入新消息（timestamp 改变）都不会再被排到顶部。
    const sortedBaseline = history.slice().sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
    );
    if (currentWorkspacePath && sortedBaseline.length > 0) {
        const ids = sortedBaseline.map(c => c.id);
        try {
            await saveHistoryOrder(ids);
        } catch (err) {
            console.error('[HistoryViewer] 初始化 history-order.json 失败:', err);
        }
    }
    return sortedBaseline;
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
        const indexRequests = indexData.requests || [];

        // 构建 msgId → startedAt（毫秒）映射：
        // index.json 的 requests[i].messages 是该次请求涉及的 messageId 列表，
        // 其中通常首个元素就是触发该请求的 user 消息。requests[i].startedAt 是该
        // 请求开始的真实时间（IDE 自己写入），可作为 user 消息的时间戳。
        const msgIdToStartedAt = new Map<string, number>();
        for (const req of indexRequests) {
            const startedAt = typeof req?.startedAt === 'number' ? req.startedAt : null;
            if (!startedAt) { continue; }
            const reqMsgs: string[] = Array.isArray(req?.messages) ? req.messages : [];
            // 只把映射建在该请求的首条 message 上（一般是 user），
            // 避免把 assistant/tool 也染上同一个时间。
            if (reqMsgs.length > 0) {
                const firstId = reqMsgs[0];
                if (typeof firstId === 'string' && !msgIdToStartedAt.has(firstId)) {
                    msgIdToStartedAt.set(firstId, startedAt);
                }
            }
        }

        const chatMessages: ChatMessage[] = [];
        const messagesDir = path.join(sessionPath, 'messages');

        for (const msgRef of indexMessages) {
            // 只处理用户消息
            if (msgRef.role !== 'user') {
                continue;
            }

            const msgFilePath = path.join(messagesDir, `${msgRef.id}.json`);
            if (!fs.existsSync(msgFilePath)) {
                continue;
            }

            try {
                const msgData = JSON.parse(fs.readFileSync(msgFilePath, 'utf-8'));
                const rawContent = extractMessageContent(msgData.message || '', Infinity);

                // 提取 <user_query> 标签内的内容，没有则跳过该消息
                const userQueryContent = extractUserQueryContent(rawContent);
                if (!userQueryContent) {
                    continue;
                }

                // 单条消息的真实时间：
                //   1. 优先 requests[].startedAt（IDE 写入的请求开始时间，最准）
                //   2. 兜底用消息文件的 mtime（用户发送/IDE 写入时刻）
                //   3. 最后退到会话目录名（数字时间戳）或 Date.now()
                let timestamp = msgIdToStartedAt.get(msgRef.id) ?? 0;
                if (!timestamp) {
                    try {
                        timestamp = fs.statSync(msgFilePath).mtimeMs;
                    } catch { /* ignore */ }
                }
                if (!timestamp) {
                    timestamp = /^\d+$/.test(sessionDir) ? parseInt(sessionDir, 10) : Date.now();
                }

                chatMessages.push({
                    role: 'user',
                    content: userQueryContent,
                    timestamp
                });
            } catch { /* ignore individual message errors */ }
        }

        let title = '未命名对话';
        let sessionId: string | undefined;

        // 优先级0（最高）: 读取用户自定义的 title.txt
        let hasCustomTitle = false;
        const customTitleFile = path.join(sessionPath, 'title.txt');
        if (fs.existsSync(customTitleFile)) {
            try {
                const customTitle = fs.readFileSync(customTitleFile, 'utf-8').trim();
                if (customTitle) {
                    title = customTitle;
                    hasCustomTitle = true;
                }
            } catch { /* ignore */ }
        }

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
                    if (!hasCustomTitle) {
                        title = conv.name;
                    }
                }
                if (conv && conv.lastMessageAt) {
                    convLastMessageAt = conv.lastMessageAt;
                }
            } catch { /* ignore */ }
        }

        // 优先级2: 从数据库读取标题（仅在没有自定义标题和 convName 时）
        const dbCache = await readSessionTitlesFromDB();
        const dbInfo = dbCache.byIdNoHyphen.get(sessionDir) || dbCache.byId.get(sessionDir);
        if (dbInfo) {
            if (!hasCustomTitle && !convName) {
                title = dbInfo.customTitle || dbInfo.title || '未命名对话';
            }
            sessionId = dbInfo.sessionId;
        }
        // 优先级3: 使用与 CodeBuddy 一致的算法从第一条用户消息生成标题
        if (!hasCustomTitle && !convName && !dbInfo) {
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
 * 保存历史记录的新排序顺序（按工作区隔离存储）
 * 将排序后的 ID 列表保存到配置文件，按 workspaceHash 隔离
 * @param orderedIds 按新顺序排列的聊天 ID 列表（格式 "workspaceHash/sessionDir"）
 */
export async function saveHistoryOrder(orderedIds: string[]): Promise<boolean> {
    try {
        if (orderedIds.length === 0) { return true; }

        // 从第一个 ID 提取 workspaceHash（格式: "workspaceHash/sessionDir"）
        const workspaceHash = orderedIds[0]?.split('/')[0];
        if (!workspaceHash) { return true; }

        const orderFilePath = path.join(os.homedir(), '.codebuddy', 'history-order.json');

        // 读取已有顺序（支持新旧两种格式）
        let orders: Record<string, string[]> = {};
        if (fs.existsSync(orderFilePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(orderFilePath, 'utf-8'));
                if (data.workspaceOrders) {
                    orders = data.workspaceOrders;
                } else if (data.order) {
                    // 旧格式：迁移到新格式（但不知道属于哪个 workspaceHash，只能丢弃）
                    // 开始使用新格式
                }
            } catch { /* ignore */ }
        }

        // 仅更新当前工作区的顺序
        orders[workspaceHash] = orderedIds;

        // 确保目录存在
        const dirPath = path.dirname(orderFilePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // 写入排序顺序（新格式：按工作区隔离）
        fs.writeFileSync(
            orderFilePath,
            JSON.stringify({ workspaceOrders: orders, updatedAt: Date.now() }, null, 2),
            'utf-8'
        );

        return true;
    } catch (error) {
        console.error('保存历史记录排序失败:', error);
        return false;
    }
}

/**
 * 读取历史记录的排序顺序（按工作区隔离读取）
 * @param workspaceHash 可选，指定工作区哈希，仅返回该工作区的顺序
 * @returns 排序后的聊天 ID 列表，如果不存在则返回空数组
 */
export function readHistoryOrder(workspaceHash?: string): string[] {
    try {
        const orderFilePath = path.join(os.homedir(), '.codebuddy', 'history-order.json');

        if (!fs.existsSync(orderFilePath)) {
            return [];
        }

        const data = JSON.parse(fs.readFileSync(orderFilePath, 'utf-8'));

        // 新格式：按工作区隔离
        if (data.workspaceOrders) {
            if (workspaceHash) {
                return data.workspaceOrders[workspaceHash] || [];
            } else {
                // 未指定工作区时返回空（不跨工作区应用顺序）
                return [];
            }
        }

        // 旧格式：全局顺序（向后兼容，仅当未指定工作区时返回）
        if (!workspaceHash) {
            return data.order || [];
        }

        return [];
    } catch (error) {
        console.error('读取历史记录排序失败:', error);
        return [];
    }
}
