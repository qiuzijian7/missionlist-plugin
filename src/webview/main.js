// Webview 前端逻辑
(function () {
    const vscode = acquireVsCodeApi();

    // 把诊断信息回传给扩展（写入 CodeBuddy History 输出面板）
    function dlog() {
        const args = Array.prototype.slice.call(arguments);
        const text = args.map(a => {
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }
            return String(a);
        }).join(' ');
        console.log('[HistoryViewer]', text);
        try { vscode.postMessage({ type: 'debugLog', text: text }); } catch (e) {}
    }

    // DOM 元素，延迟到 DOMContentLoaded 后获取
    let historyList = null;
    let emptyState = null;
    let refreshBtn = null;
    let sortSelect = null;
    let domReady = false;
    const messageQueue = [];

    let currentHistory = [];
    // 默认手动排序：以用户拖拽后保存到 history-order.json 的顺序为准
    // 后端在没有 customOrder 时会以时间倒序作为初始 baseline；
    // 用户拖拽过一次后，即固化，不再被任何"自动排序"覆盖
    let currentSort = 'custom';

    // 拖拽状态
    let dragState = {
        isDragging: false,
        chatId: null,
        dragIndex: -1,
        startY: 0,
        ghostEl: null,
        sourceWrapper: null,
        dropTargetId: null,
        dropPosition: null,
    };

    let clickSuppressed = false;

    // 是否正在编辑标题（防止刷新时销毁输入态）
    let isEditingTitle = false;

    // 存储状态映射
    let statusMap = {};
    let activeSessionId = null;
    let expandedItems = new Set();
    let chatDetails = {};
    /**
     * 对仍处于展开状态的会话发起 loadChatDetail 请求
     * 不再做节流——loadChatDetail 是廉价的纯文件读取，
     * 多次触发由后端去重无害；前端在 updateChatDetail 处用 length 比对避免回退覆盖
     */
    function reloadExpandedDetails() {
        expandedItems.forEach(chatId => {
            const chat = currentHistory.find(c => c.id === chatId);
            if (!chat) {
                // 该会话已不存在（被删除等），清理缓存与展开标记
                expandedItems.delete(chatId);
                delete chatDetails[chatId];
                return;
            }
            vscode.postMessage({ type: 'loadChatDetail', chatId: chatId });
        });
    }

    // ===== 消息处理 =====
    function handleMessage(message) {
        switch (message.type) {
            case 'updateHistory':
                // 如果正在编辑标题，跳过列表刷新，避免销毁输入态
                if (isEditingTitle) {
                    dlog('跳过 updateHistory：正在编辑标题');
                    return;
                }
                currentHistory = message.data || [];
                sortAndDisplayHistory();
                // 列表刷新后，对仍处于展开状态的会话强制重新拉取详情
                // 否则用户在 IDE 里发了新消息后，展开内容仍是旧缓存，看不到新消息
                reloadExpandedDetails();
                break;
            case 'updateStatus':
                statusMap = message.data || {};
                refreshAllIndicators();
                // 状态变化时（通常对应新消息触发的 running/completed 切换）
                // 也尝试刷新展开会话详情，作为 contentChanged 触发 refresh 的兜底
                reloadExpandedDetails();
                break;
            case 'updateActiveSession':
                activeSessionId = message.data;
                dlog('updateActiveSession received:', activeSessionId);
                dlog('当前 currentHistory 共', currentHistory.length, '条');
                currentHistory.forEach(c => {
                    dlog(`  chat.id="${c.id}" sessionDir="${c.sessionDir || ''}"`);
                });
                refreshAllIndicators();
                // 活跃会话变化时也尝试刷新展开的会话详情（节流仍生效）
                // 这样在 statusMonitor 触发 refresh 失败的情况下，仍有兜底机会
                reloadExpandedDetails();
                break;
            case 'updateChatDetail':
                if (message.data) {
                    const incoming = message.data;
                    const cached = chatDetails[incoming.id];
                    const incomingLen = (incoming.messages && incoming.messages.length) || 0;
                    const cachedLen = (cached && cached.messages && cached.messages.length) || 0;
                    // 仅在收到的 detail 不少于已缓存数量时才接受，
                    // 避免 CodeBuddy 写文件中间态返回的"短数据"覆盖已渲染的完整数据
                    if (cached && incomingLen < cachedLen) {
                        dlog(`updateChatDetail dropped: incomingLen=${incomingLen} < cachedLen=${cachedLen} for ${incoming.id}`);
                        break;
                    }
                    chatDetails[incoming.id] = incoming;
                    if (expandedItems.has(incoming.id)) {
                        const expandedContent = document.querySelector(`[data-chat-id="${incoming.id}"] .expanded-content`);
                        if (expandedContent) {
                            renderExpandedContent(expandedContent, incoming);
                        }
                    }
                }
                break;
        }
    }

    // 缓存早期消息，DOM 未就绪时不处理
    window.addEventListener('message', (event) => {
        if (!domReady) {
            messageQueue.push(event.data);
            return;
        }
        handleMessage(event.data);
    });

    // ===== 初始化：DOM 就绪后执行 =====
    function init() {
        historyList = document.getElementById('historyList');
        emptyState = document.getElementById('emptyState');
        refreshBtn = document.getElementById('refreshBtn');
        sortSelect = document.getElementById('sortSelect');

        if (!historyList || !emptyState) {
            console.error('[HistoryViewer] Failed to get DOM elements');
            return;
        }

        // 绑定刷新按钮
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'refresh' });
            });
        }

        // 绑定排序选择
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                currentSort = e.target.value;
                sortAndDisplayHistory();
            });
        }

        // 处理缓存的消息
        while (messageQueue.length > 0) {
            handleMessage(messageQueue.shift());
        }

        domReady = true;

        // 请求初始数据
        vscode.postMessage({ type: 'refresh' });
    }

    // 根据 document.readyState 决定立即初始化还是等待 DOMContentLoaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ===== 排序并显示历史记录 =====
    function sortAndDisplayHistory() {
        const listEl = document.getElementById('historyList');
        const emptyEl = document.getElementById('emptyState');
        if (!listEl || !emptyEl) {
            console.error('[HistoryViewer] sortAndDisplayHistory: DOM elements not ready');
            return;
        }

        if (!currentHistory || currentHistory.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }

        emptyEl.style.display = 'none';

        switch (currentSort) {
            case 'time-asc':
                currentHistory.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                break;
            case 'time-desc':
                currentHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                break;
            case 'title-asc':
                currentHistory.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
                break;
            case 'title-desc':
                currentHistory.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'zh-CN'));
                break;
            case 'messages-asc':
                currentHistory.sort((a, b) => (a.messages?.length || 0) - (b.messages?.length || 0));
                break;
            case 'messages-desc':
                currentHistory.sort((a, b) => (b.messages?.length || 0) - (a.messages?.length || 0));
                break;
            case 'custom':
                break;
        }

        listEl.innerHTML = '';
        currentHistory.forEach((chat, index) => {
            const item = createHistoryItem(chat, index);
            listEl.appendChild(item);
        });

        refreshAllIndicators();
    }

    // ===== 创建历史记录项 =====
    function createHistoryItem(chat, index) {
        const wrapper = document.createElement('div');
        wrapper.className = 'history-item-wrapper';
        wrapper.dataset.chatId = chat.id;

        const div = document.createElement('div');
        div.className = 'history-item';
        div.dataset.chatId = chat.id;
        div.dataset.index = index;

        const sessionDir = chat.sessionDir || '';
        const isActiveSession = activeSessionId && sessionDir &&
            (activeSessionId === sessionDir || activeSessionId.endsWith('/' + sessionDir));
        if (isActiveSession) {
            div.classList.add('selected', 'active-session');
        }

        div.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.action-btn') || e.target.closest('.expand-btn') || e.target.closest('input')) return;
            onItemMouseDown(chat.id, e);
        });

        // 展开/折叠按钮
        const expandBtn = document.createElement('span');
        expandBtn.className = 'expand-btn';
        expandBtn.textContent = expandedItems.has(chat.id) ? '▼' : '▶';
        expandBtn.title = expandedItems.has(chat.id) ? '折叠' : '展开详情';
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExpand(chat);
        });
        div.appendChild(expandBtn);

        // 状态指示器
        const effectiveStatus = getEffectiveStatus(chat.id);
        const statusIndicator = document.createElement('div');
        statusIndicator.className = 'status-indicator ' + getStatusClass(effectiveStatus);
        statusIndicator.title = getStatusText(effectiveStatus);
        div.appendChild(statusIndicator);

        // 内容容器
        const content = document.createElement('div');
        content.className = 'history-content';

        const title = document.createElement('div');
        title.className = 'history-title';
        title.textContent = chat.title || '无标题对话';

        const preview = document.createElement('div');
        preview.className = 'history-preview';
        preview.textContent = chat.preview || '无预览';

        const meta = document.createElement('div');
        meta.className = 'history-meta';

        const time = document.createElement('span');
        time.className = 'history-time';
        time.textContent = formatTime(chat.timestamp);

        const messages = document.createElement('span');
        messages.className = 'history-messages';
        messages.textContent = `${chat.messages ? chat.messages.length : 0} 条消息`;

        const statusText = document.createElement('span');
        statusText.className = 'history-status';
        statusText.textContent = getStatusText(effectiveStatus);

        meta.appendChild(time);
        meta.appendChild(messages);
        meta.appendChild(statusText);

        content.appendChild(title);
        content.appendChild(preview);
        content.appendChild(meta);
        div.appendChild(content);

        // 操作按钮
        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'action-btn rename-btn';
        renameBtn.title = '重命名';
        renameBtn.textContent = '✏️';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            enableRename(chat, title);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.title = '删除';
        deleteBtn.textContent = '🗑️';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDelete(chat);
        });

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        div.appendChild(actions);

        // 点击打开会话
        div.addEventListener('click', (e) => {
            if (clickSuppressed) {
                clickSuppressed = false;
                return;
            }
            if (e.target.closest('.action-btn') || e.target.closest('.expand-btn') || e.target.closest('input')) {
                return;
            }

            // 立即在前端更新选中高亮，不等后端异步推送 updateActiveSession
            // 这样用户点击后高亮切换是即时的，避免时序竞争导致高亮不更新
            const newActiveDir = chat.sessionDir || '';
            if (newActiveDir && newActiveDir !== activeSessionId) {
                activeSessionId = newActiveDir;
                refreshAllIndicators();
            }

            vscode.postMessage({
                type: 'openSessionInCodeBuddy',
                sessionId: chat.sessionId,
                sessionDir: chat.sessionDir,
                workspaceHash: chat.workspaceHash
            });
        });

        wrapper.appendChild(div);

        // 展开内容容器
        const expandedContent = document.createElement('div');
        expandedContent.className = 'expanded-content';
        expandedContent.dataset.chatId = chat.id;
        expandedContent.style.display = expandedItems.has(chat.id) ? 'block' : 'none';

        if (expandedItems.has(chat.id) && chatDetails[chat.id]) {
            renderExpandedContent(expandedContent, chatDetails[chat.id]);
        } else if (expandedItems.has(chat.id)) {
            expandedContent.textContent = '加载中...';
        }

        wrapper.appendChild(expandedContent);

        return wrapper;
    }

    // ===== 启用重命名模式 =====
    function enableRename(chat, titleElement) {
        isEditingTitle = true;  // 标记正在编辑标题
        const currentTitle = chat.title || '无标题对话';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = currentTitle;

        const parent = titleElement.parentNode;
        parent.replaceChild(input, titleElement);
        input.focus();
        input.select();

        const saveRename = () => {
            isEditingTitle = false;  // 清除编辑标志
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== currentTitle) {
                vscode.postMessage({
                    type: 'renameChat',
                    chatId: chat.id,
                    newTitle: newTitle
                });
                chat.title = newTitle;
                titleElement.textContent = newTitle;
            }
            parent.replaceChild(titleElement, input);
            // 编辑完成后手动触发刷新，获取最新数据
            setTimeout(() => vscode.postMessage({ type: 'refresh' }), 100);
        };

        const cancelRename = () => {
            isEditingTitle = false;  // 清除编辑标志
            parent.replaceChild(titleElement, input);
            // 编辑完成后手动触发刷新，获取最新数据
            setTimeout(() => vscode.postMessage({ type: 'refresh' }), 100);
        };

        input.addEventListener('blur', saveRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveRename();
            else if (e.key === 'Escape') cancelRename();
        });
    }

    function confirmDelete(chat) {
        vscode.postMessage({
            type: 'deleteChat',
            chatId: chat.id,
            title: chat.title || '无标题对话'
        });
    }

    // ===== 格式化时间 =====
    function formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

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

    // 单条消息的时间标签：今天显示 HH:mm，其他日期显示 M/D HH:mm
    function formatMessageTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const sameDay = date.getFullYear() === now.getFullYear()
            && date.getMonth() === now.getMonth()
            && date.getDate() === now.getDate();
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        if (sameDay) {
            return `${hh}:${mm}`;
        }
        return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
    }

    // ===== 刷新所有指示灯 =====
    function refreshAllIndicators() {
        const listEl = document.getElementById('historyList');
        if (!listEl) {
            dlog('refreshAllIndicators: historyList 不存在！');
            return;
        }

        const items = listEl.querySelectorAll('.history-item');
        dlog(`refreshAllIndicators: activeSessionId="${activeSessionId}", DOM items=${items.length}, history=${currentHistory.length}`);

        let matchedCount = 0;
        items.forEach(item => {
            const chatId = item.dataset.chatId;
            if (!chatId) return;

            const chat = currentHistory.find(c => c.id === chatId);
            if (!chat) {
                dlog(`  [跳过] chatId="${chatId}" 在 currentHistory 中找不到`);
                return;
            }

            const sessionDir = chat.sessionDir || '';
            const isActive = activeSessionId && sessionDir &&
                (activeSessionId === sessionDir || activeSessionId.endsWith('/' + sessionDir));
            const effectiveStatus = getEffectiveStatus(chatId);

            if (isActive) {
                matchedCount++;
                dlog(`  [✓ MATCH] chatId="${chatId}" sessionDir="${sessionDir}" activeSessionId="${activeSessionId}"`);
            }

            const indicator = item.querySelector('.status-indicator');
            if (indicator) {
                indicator.className = 'status-indicator ' + getStatusClass(effectiveStatus);
                indicator.title = getStatusText(effectiveStatus);
            }

            if (isActive) {
                item.classList.add('selected', 'active-session');
            } else {
                item.classList.remove('selected', 'active-session');
            }

            const statusText = item.querySelector('.history-status');
            if (statusText) {
                statusText.textContent = getStatusText(effectiveStatus);
            }
        });

        if (activeSessionId && matchedCount === 0) {
            dlog(`  [✗ NO MATCH] activeSessionId="${activeSessionId}" 但没有任何 item 匹配上`);
            // 列出前 3 个 item 的 sessionDir 帮助排查
            const samples = currentHistory.slice(0, 3).map(c => `id="${c.id}" sessionDir="${c.sessionDir}"`);
            dlog(`  采样前 3 条历史: ${samples.join(' | ')}`);
        }
    }

    // ===== 状态相关函数 =====
    function getEffectiveStatus(chatId) {
        const chat = currentHistory.find(c => c.id === chatId);
        if (!chat) return 'idle';

        const sessionDir = chat.sessionDir || '';
        const isActive = activeSessionId && sessionDir &&
            (activeSessionId === sessionDir || activeSessionId.endsWith('/' + sessionDir));
        const requestStatus = statusMap[chatId] || chat.status || 'idle';

        if (requestStatus === 'running') return 'running';
        if (requestStatus === 'error') return 'error';
        if (requestStatus === 'pending') return 'pending';
        if (isActive) return 'active';
        if (requestStatus === 'completed') return 'completed';
        return 'idle';
    }

    function getStatusText(status) {
        const map = {
            'idle': '空闲',
            'running': '运行中',
            'error': '错误',
            'completed': '已完成',
            'pending': '等待中',
            'active': '当前会话'
        };
        return map[status] || '未知';
    }

    function getStatusClass(status) {
        const map = {
            'idle': 'status-idle',
            'running': 'status-running',
            'error': 'status-error',
            'completed': 'status-completed',
            'pending': 'status-pending',
            'active': 'status-active'
        };
        return map[status] || 'status-unknown';
    }

    // ===== 切换展开/折叠 =====
    function toggleExpand(chat) {
        const chatId = chat.id;
        if (expandedItems.has(chatId)) {
            expandedItems.delete(chatId);
        } else {
            expandedItems.add(chatId);
            vscode.postMessage({
                type: 'loadChatDetail',
                chatId: chatId
            });
        }

        const expandBtn = document.querySelector(`[data-chat-id="${chatId}"] .expand-btn`);
        if (expandBtn) {
            expandBtn.textContent = expandedItems.has(chatId) ? '▼' : '▶';
            expandBtn.title = expandedItems.has(chatId) ? '折叠' : '展开详情';
        }

        const expandedContent = document.querySelector(`[data-chat-id="${chatId}"] .expanded-content`);
        if (expandedContent) {
            if (expandedItems.has(chatId)) {
                expandedContent.style.display = 'block';
                if (chatDetails[chatId]) {
                    renderExpandedContent(expandedContent, chatDetails[chatId]);
                } else {
                    expandedContent.textContent = '加载中...';
                }
            } else {
                expandedContent.style.display = 'none';
            }
        }
    }

    // ===== 渲染展开内容 =====
    function renderExpandedContent(container, chatDetail) {
        container.innerHTML = '';

        if (!chatDetail.messages || chatDetail.messages.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'expanded-empty';
            emptyMsg.textContent = '暂无用户输入';
            container.appendChild(emptyMsg);
            return;
        }

        const messagesList = document.createElement('div');
        messagesList.className = 'expanded-messages';

        const reversedMessages = [...chatDetail.messages].reverse();
        reversedMessages.forEach((msg, idx) => {
            const displayContent = msg.content || '';

            const msgDiv = document.createElement('div');
            msgDiv.className = 'expanded-message';

            const msgHeader = document.createElement('div');
            msgHeader.className = 'expanded-message-header';

            const msgIndexSpan = document.createElement('span');
            msgIndexSpan.className = 'expanded-message-index';
            msgIndexSpan.textContent = `消息 ${chatDetail.messages.length - idx}`;
            msgHeader.appendChild(msgIndexSpan);

            // 消息时间：显示在标题右侧（淡色小字）。
            // 时间戳由后端 historyReader 写入：优先用 requests[].startedAt，
            // 其次用消息文件 mtime。无效时不显示。
            if (msg.timestamp && Number.isFinite(msg.timestamp) && msg.timestamp > 0) {
                const timeSpan = document.createElement('span');
                timeSpan.className = 'expanded-message-time';
                timeSpan.textContent = formatMessageTime(msg.timestamp);
                timeSpan.title = new Date(msg.timestamp).toLocaleString();
                msgHeader.appendChild(timeSpan);
            }

            const msgContent = document.createElement('div');
            msgContent.className = 'expanded-message-content';
            msgContent.textContent = displayContent.substring(0, 200) + (displayContent.length > 200 ? '...' : '');

            msgDiv.appendChild(msgHeader);
            msgDiv.appendChild(msgContent);
            messagesList.appendChild(msgDiv);
        });

        container.appendChild(messagesList);
    }

    // ===== 鼠标拖拽排序 =====
    function onItemMouseDown(chatId, e) {
        dragState.chatId = chatId;
        dragState.startY = e.clientY;
        dragState.sourceWrapper = e.currentTarget.closest('.history-item-wrapper');
        clickSuppressed = false;

        e.preventDefault();
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragUp);
    }

    function onDragMove(e) {
        const dy = Math.abs(e.clientY - dragState.startY);

        if (!dragState.isDragging) {
            if (dy < 5) return;

            dragState.isDragging = true;
            dragState.dragIndex = currentHistory.findIndex(c => c.id === dragState.chatId);
            clickSuppressed = true;
            document.body.classList.add('is-dragging');
            createGhostElement(e);
            if (dragState.sourceWrapper) {
                dragState.sourceWrapper.classList.add('drag-placeholder');
            }
        }

        if (dragState.isDragging) {
            moveGhostElement(e);
            updateDropPosition(e);
        }
    }

    function onDragUp(e) {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragUp);

        if (dragState.isDragging) {
            if (dragState.dropTargetId && dragState.dropPosition) {
                performDrop();
            }
            removeGhostElement();
            clearDragState();
        } else {
            dragState.chatId = null;
        }
    }

    function createGhostElement(e) {
        const sourceItem = dragState.sourceWrapper?.querySelector('.history-item');
        if (!sourceItem) return;

        const ghost = sourceItem.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = sourceItem.offsetWidth + 'px';
        document.body.appendChild(ghost);
        dragState.ghostEl = ghost;
        moveGhostElement(e);
    }

    function moveGhostElement(e) {
        if (!dragState.ghostEl) return;
        dragState.ghostEl.style.left = (e.clientX + 12) + 'px';
        dragState.ghostEl.style.top = (e.clientY - 20) + 'px';
    }

    function updateDropPosition(e) {
        clearDropIndicators();

        const listEl = document.getElementById('historyList');
        if (!listEl) return;

        const wrappers = Array.from(listEl.querySelectorAll('.history-item-wrapper'));
        const mouseY = e.clientY;

        for (const wrapper of wrappers) {
            const rect = wrapper.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;

            if (mouseY >= rect.top && mouseY <= rect.bottom) {
                const item = wrapper.querySelector('.history-item');
                const chatId = item?.dataset.chatId;

                if (chatId === dragState.chatId) {
                    dragState.dropTargetId = null;
                    dragState.dropPosition = null;
                    return;
                }

                dragState.dropTargetId = chatId;

                if (mouseY < midY) {
                    dragState.dropPosition = 'before';
                    wrapper.classList.add('drop-above');
                } else {
                    dragState.dropPosition = 'after';
                    wrapper.classList.add('drop-below');
                }
                return;
            }
        }

        dragState.dropTargetId = null;
        dragState.dropPosition = null;
    }

    function performDrop() {
        const fromIndex = dragState.dragIndex;
        const targetIndex = currentHistory.findIndex(c => c.id === dragState.dropTargetId);

        if (fromIndex < 0 || targetIndex < 0) return;

        const [draggedChat] = currentHistory.splice(fromIndex, 1);

        let insertIndex = currentHistory.findIndex(c => c.id === dragState.dropTargetId);
        if (dragState.dropPosition === 'after') {
            insertIndex += 1;
        }

        currentHistory.splice(insertIndex, 0, draggedChat);

        currentSort = 'custom';
        const sortEl = document.getElementById('sortSelect');
        if (sortEl) sortEl.value = 'custom';

        sortAndDisplayHistory();

        vscode.postMessage({
            type: 'reorderHistory',
            data: currentHistory.map(chat => chat.id)
        });
    }

    function clearDropIndicators() {
        const listEl = document.getElementById('historyList');
        if (!listEl) return;
        listEl.querySelectorAll('.drop-above, .drop-below').forEach(el => {
            el.classList.remove('drop-above', 'drop-below');
        });
    }

    function removeGhostElement() {
        if (dragState.ghostEl) {
            dragState.ghostEl.remove();
            dragState.ghostEl = null;
        }
    }

    function clearDragState() {
        document.body.classList.remove('is-dragging');
        if (dragState.sourceWrapper) {
            dragState.sourceWrapper.classList.remove('drag-placeholder');
        }
        clearDropIndicators();

        dragState.isDragging = false;
        dragState.chatId = null;
        dragState.dragIndex = -1;
        dragState.sourceWrapper = null;
        dragState.dropTargetId = null;
        dragState.dropPosition = null;
    }

})();
