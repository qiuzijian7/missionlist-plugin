// Webview 前端逻辑
(function () {
    const vscode = acquireVsCodeApi();
    const historyList = document.getElementById('historyList');
    const emptyState = document.getElementById('emptyState');
    const refreshBtn = document.getElementById('refreshBtn');
    const sortSelect = document.getElementById('sortSelect');

    let currentHistory = [];
    let currentSort = 'time-desc'; // 默认按时间降序，拖拽后切换为 'custom'

    // 拖拽状态
    let dragState = {
        isDragging: false,      // 是否正在拖拽
        chatId: null,           // 被拖拽项的 ID
        dragIndex: -1,          // 被拖拽项在 currentHistory 中的索引
        startY: 0,              // 拖拽起始 Y 坐标
        ghostEl: null,          // 拖拽幽灵元素
        sourceWrapper: null,    // 被拖拽的原始 wrapper 元素
        dropTargetId: null,     // 当前放置目标 ID
        dropPosition: null,     // 放置位置：'before' 或 'after'
    };

    // 标记拖拽后抑制 click 事件
    let clickSuppressed = false;

    // 刷新按钮
    refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
    });

    // 排序选择
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            sortAndDisplayHistory();
        });
    }

    // 存储状态映射
    let statusMap = {};

    // 当前激活的会话 ID（用于高亮显示）
    let activeSessionId = null;

    // 存储展开的会话 ID 集合
    let expandedItems = new Set();

    // 存储聊天详情数据
    let chatDetails = {};

    // 监听来自扩展的消息
    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
            case 'updateHistory':
                currentHistory = message.data || [];
                sortAndDisplayHistory();
                break;
            case 'updateStatus':
                statusMap = message.data || {};
                updateStatusDisplay();
                break;
            case 'updateActiveSession':
                activeSessionId = message.data;
                updateActiveSessionDisplay();
                break;
            case 'updateChatDetail':
                // 保存聊天详情并显示
                if (message.data) {
                    chatDetails[message.data.id] = message.data;
                    // 如果该会话已展开，渲染内容
                    if (expandedItems.has(message.data.id)) {
                        const expandedContent = document.querySelector(`[data-chat-id="${message.data.id}"] .expanded-content`);
                        if (expandedContent) {
                            renderExpandedContent(expandedContent, message.data);
                        }
                    }
                }
                break;
        }
    });

    // 排序并显示历史记录
    function sortAndDisplayHistory() {
        if (!currentHistory || currentHistory.length === 0) {
            historyList.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        
        // 直接对 currentHistory 排序以保持排序状态
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
                // 手动排序（拖拽后），不重新排序，保持 currentHistory 原有顺序
                break;
        }
        
        historyList.innerHTML = '';
        currentHistory.forEach((chat, index) => {
            const item = createHistoryItem(chat, index);
            historyList.appendChild(item);
        });
    }

    // 创建历史记录项
    function createHistoryItem(chat, index) {
        // 外层 wrapper（用于包含主行 + 展开内容）
        const wrapper = document.createElement('div');
        wrapper.className = 'history-item-wrapper';
        wrapper.dataset.chatId = chat.id;

        // 主行（可拖拽、可点击）
        const div = document.createElement('div');
        div.className = 'history-item';
        div.dataset.chatId = chat.id;
        div.dataset.index = index;

        // 检查是否为当前激活的会话
        const sessionDir = chat.sessionDir || '';
        const isActiveSession = activeSessionId && sessionDir && activeSessionId === sessionDir;
        if (isActiveSession) {
            div.classList.add('selected', 'active-session');
        }

        // 鼠标按下启动拖拽追踪
        div.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.action-btn') || e.target.closest('.expand-btn')) return;
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
        const statusIndicator = document.createElement('div');
        const currentStatus = chat.status || statusMap[chat.id] || 'idle';
        statusIndicator.className = 'status-indicator ' + getStatusClass(currentStatus);
        statusIndicator.title = getStatusText(currentStatus);
        div.appendChild(statusIndicator);

        // 活跃会话绿灯指示器
        if (isActiveSession) {
            const activeIndicator = document.createElement('div');
            activeIndicator.className = 'active-indicator';
            activeIndicator.title = '当前会话';
            div.appendChild(activeIndicator);
        }

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
        statusText.textContent = getStatusText(currentStatus);

        meta.appendChild(time);
        meta.appendChild(messages);
        meta.appendChild(statusText);

        content.appendChild(title);
        content.appendChild(preview);
        content.appendChild(meta);

        div.appendChild(content);

        // 操作按钮容器
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
            if (e.target.closest('.action-btn') || e.target.closest('.expand-btn')) {
                return;
            }
            vscode.postMessage({ 
                type: 'openSessionInCodeBuddy',
                sessionId: chat.sessionId,
                sessionDir: chat.sessionDir,
                workspaceHash: chat.workspaceHash
            });
        });

        wrapper.appendChild(div);

        // 展开内容容器（放在 wrapper 中，不在 flex 行内）
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

    // 启用重命名模式
    function enableRename(chat, titleElement) {
        const currentTitle = chat.title || '无标题对话';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = currentTitle;
        
        // 替换标题元素为输入框
        const parent = titleElement.parentNode;
        parent.replaceChild(input, titleElement);
        input.focus();
        input.select();

        // 保存重命名
        const saveRename = () => {
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== currentTitle) {
                vscode.postMessage({
                    type: 'renameChat',
                    chatId: chat.id,
                    newTitle: newTitle
                });
                // 更新本地显示
                chat.title = newTitle;
                titleElement.textContent = newTitle;
            }
            // 恢复标题显示
            parent.replaceChild(titleElement, input);
        };

        // 取消重命名
        const cancelRename = () => {
            parent.replaceChild(titleElement, input);
        };

        input.addEventListener('blur', saveRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveRename();
            } else if (e.key === 'Escape') {
                cancelRename();
            }
        });
    }

    // 确认删除
    function confirmDelete(chat) {
        vscode.postMessage({
            type: 'deleteChat',
            chatId: chat.id,
            title: chat.title || '无标题对话'
        });
    }

    // 格式化时间
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

    // 更新状态显示
    function updateStatusDisplay() {
        const items = historyList.querySelectorAll('.history-item');
        items.forEach(item => {
            const chatId = item.dataset.chatId;
            if (chatId && statusMap[chatId]) {
                const indicator = item.querySelector('.status-indicator');
                if (indicator) {
                    const status = statusMap[chatId];
                    indicator.className = 'status-indicator ' + getStatusClass(status);
                    indicator.title = getStatusText(status);
                }

                // 更新元数据中的状态文本
                const statusText = item.querySelector('.history-status');
                if (statusText) {
                    statusText.textContent = getStatusText(statusMap[chatId]);
                }
            }
        });
    }

    // 更新激活会话的高亮显示
    function updateActiveSessionDisplay() {
        const items = historyList.querySelectorAll('.history-item');
        items.forEach(item => {
            const chatId = item.dataset.chatId;
            if (chatId) {
                // 从 currentHistory 中找到对应的 chat 对象
                const chat = currentHistory.find(c => c.id === chatId);
                if (chat) {
                    const sessionDir = chat.sessionDir || '';
                    const isActive = activeSessionId && sessionDir && activeSessionId === sessionDir;
                    if (isActive) {
                        item.classList.add('selected', 'active-session');
                        // 如果还没有绿灯指示器，添加一个
                        if (!item.querySelector('.active-indicator')) {
                            const activeIndicator = document.createElement('div');
                            activeIndicator.className = 'active-indicator';
                            activeIndicator.title = '当前会话';
                            // 插入到状态指示器后面
                            const statusIndicator = item.querySelector('.status-indicator');
                            if (statusIndicator && statusIndicator.nextSibling) {
                                item.insertBefore(activeIndicator, statusIndicator.nextSibling);
                            } else if (statusIndicator) {
                                item.appendChild(activeIndicator);
                            }
                        }
                    } else {
                        item.classList.remove('selected', 'active-session');
                        // 移除绿灯指示器
                        const activeIndicator = item.querySelector('.active-indicator');
                        if (activeIndicator) {
                            activeIndicator.remove();
                        }
                    }
                }
            }
        });
    }

    // 获取状态显示文本
    function getStatusText(status) {
        const map = {
            'idle': '空闲',
            'running': '执行中',
            'error': '错误',
            'completed': '已完成',
            'pending': '等待中'
        };
        return map[status] || '未知';
    }

    // 获取状态 CSS 类名
    function getStatusClass(status) {
        const map = {
            'idle': 'status-idle',
            'running': 'status-running',
            'error': 'status-error',
            'completed': 'status-completed',
            'pending': 'status-pending'
        };
        return map[status] || 'status-unknown';
    }

    // 切换展开/折叠状态
    function toggleExpand(chat) {
        const chatId = chat.id;
        if (expandedItems.has(chatId)) {
            // 折叠
            expandedItems.delete(chatId);
        } else {
            // 展开 - 请求聊天详情
            expandedItems.add(chatId);
            vscode.postMessage({
                type: 'loadChatDetail',
                chatId: chatId
            });
        }
        
        // 更新展开按钮文本
        const expandBtn = document.querySelector(`[data-chat-id="${chatId}"] .expand-btn`);
        if (expandBtn) {
            expandBtn.textContent = expandedItems.has(chatId) ? '▼' : '▶';
            expandBtn.title = expandedItems.has(chatId) ? '折叠' : '展开详情';
        }

        // 显示/隐藏展开内容
        const expandedContent = document.querySelector(`[data-chat-id="${chatId}"] .expanded-content`);
        if (expandedContent) {
            if (expandedItems.has(chatId)) {
                expandedContent.style.display = 'block';
                // 如果已有详情数据，直接渲染
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

    // 渲染展开的内容（用户消息列表）
    function renderExpandedContent(container, chatDetail) {
        container.innerHTML = '';
        
        if (!chatDetail.messages || chatDetail.messages.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'expanded-empty';
            emptyMsg.textContent = '暂无用户输入';
            container.appendChild(emptyMsg);
            return;
        }

        // 后端已过滤，messages 中只有包含 <user_query> 的用户消息
        const messagesList = document.createElement('div');
        messagesList.className = 'expanded-messages';

        chatDetail.messages.forEach((msg, idx) => {
            const displayContent = msg.content || '';
            
            const msgDiv = document.createElement('div');
            msgDiv.className = 'expanded-message';
            
            const msgHeader = document.createElement('div');
            msgHeader.className = 'expanded-message-header';
            msgHeader.textContent = `消息 ${idx + 1}`;
            
            const msgContent = document.createElement('div');
            msgContent.className = 'expanded-message-content';
            msgContent.textContent = displayContent.substring(0, 200) + (displayContent.length > 200 ? '...' : '');
            
            msgDiv.appendChild(msgHeader);
            msgDiv.appendChild(msgContent);
            messagesList.appendChild(msgDiv);
        });

        container.appendChild(messagesList);
    }

    // ========== 鼠标拖拽排序 ==========

    function onItemMouseDown(chatId, e) {
        dragState.chatId = chatId;
        dragState.startY = e.clientY;
        dragState.sourceWrapper = e.currentTarget.closest('.history-item-wrapper');
        clickSuppressed = false;

        e.preventDefault(); // 阻止默认行为，避免选中文字

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragUp);
    }

    function onDragMove(e) {
        const dy = Math.abs(e.clientY - dragState.startY);

        if (!dragState.isDragging) {
            if (dy < 5) return; // 阈值，避免误触

            // 开始拖拽
            dragState.isDragging = true;
            dragState.dragIndex = currentHistory.findIndex(c => c.id === dragState.chatId);
            clickSuppressed = true;
            document.body.classList.add('is-dragging');

            // 创建幽灵元素
            createGhostElement(e);

            // 标记原始位置
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

        const wrappers = Array.from(historyList.querySelectorAll('.history-item-wrapper'));
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
        if (sortSelect) {
            sortSelect.value = 'custom';
        }

        sortAndDisplayHistory();

        vscode.postMessage({
            type: 'reorderHistory',
            data: currentHistory.map(chat => chat.id)
        });
    }

    function clearDropIndicators() {
        historyList.querySelectorAll('.drop-above, .drop-below').forEach(el => {
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

    // 初始加载
    vscode.postMessage({ type: 'refresh' });
})();



