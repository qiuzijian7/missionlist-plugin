// Webview 前端逻辑
(function () {
    const vscode = acquireVsCodeApi();
    const historyList = document.getElementById('historyList');
    const emptyState = document.getElementById('emptyState');
    const refreshBtn = document.getElementById('refreshBtn');
    const sortSelect = document.getElementById('sortSelect');

    let currentHistory = [];
    let currentSort = 'time-desc'; // 默认按时间降序
    let draggedItem = null; // 当前拖拽的元素
    let draggedIndex = -1; // 拖拽元素的索引

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
        
        // 复制数组以避免修改原数据
        const sorted = [...currentHistory];
        
        // 根据选择的排序方式排序
        switch (currentSort) {
            case 'time-asc':
                sorted.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                break;
            case 'time-desc':
                sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                break;
            case 'title-asc':
                sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
                break;
            case 'title-desc':
                sorted.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'zh-CN'));
                break;
            case 'messages-asc':
                sorted.sort((a, b) => (a.messages?.length || 0) - (b.messages?.length || 0));
                break;
            case 'messages-desc':
                sorted.sort((a, b) => (b.messages?.length || 0) - (a.messages?.length || 0));
                break;
        }
        
        historyList.innerHTML = '';
        sorted.forEach((chat, index) => {
            const item = createHistoryItem(chat, index);
            historyList.appendChild(item);
        });
    }

    // 创建历史记录项
    function createHistoryItem(chat, index) {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.dataset.chatId = chat.id;
        div.dataset.index = index; // 添加索引以便于拖拽排序

        // 启用拖拽
        div.draggable = true;
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('dragenter', handleDragEnter);
        div.addEventListener('dragleave', handleDragLeave);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragend', handleDragEnd);

        // 状态指示器
        const statusIndicator = document.createElement('div');
        const currentStatus = chat.status || statusMap[chat.id] || 'idle';
        statusIndicator.className = 'status-indicator ' + getStatusClass(currentStatus);
        statusIndicator.title = getStatusText(currentStatus);
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

        // 重命名按钮
        const renameBtn = document.createElement('button');
        renameBtn.className = 'action-btn rename-btn';
        renameBtn.title = '重命名';
        renameBtn.textContent = '✏️';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止事件冒泡
            enableRename(chat, title);
        });

        // 删除按钮
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.title = '删除';
        deleteBtn.textContent = '🗑️';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止事件冒泡
            confirmDelete(chat);
        });

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        div.appendChild(actions);

        // 点击在 CodeBuddy 中打开该会话
        div.addEventListener('click', () => {
            vscode.postMessage({ 
                type: 'openSessionInCodeBuddy',
                sessionId: chat.sessionId,
                sessionDir: chat.sessionDir,
                workspaceHash: chat.workspaceHash
            });
        });

        return div;
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

    // 拖拽开始
    function handleDragStart(e) {
        draggedItem = this;
        draggedIndex = parseInt(this.dataset.index);
        this.classList.add('dragging');
        
        // 设置拖拽数据
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', this.innerHTML);
    }

    // 拖拽经过
    function handleDragOver(e) {
        if (e.preventDefault) {
            e.preventDefault(); // 允许放置
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    // 拖拽进入
    function handleDragEnter(e) {
        if (this !== draggedItem) {
            this.classList.add('drag-over');
        }
    }

    // 拖拽离开
    function handleDragLeave(e) {
        this.classList.remove('drag-over');
    }

    // 放置
    function handleDrop(e) {
        if (e.stopPropagation) {
            e.stopPropagation(); // 阻止事件冒泡
        }

        if (draggedItem !== this) {
            // 获取拖放目标的索引
            const targetIndex = parseInt(this.dataset.index);
            
            // 从 currentHistory 中移除拖拽的元素
            const [draggedChat] = currentHistory.splice(draggedIndex, 1);
            
            // 插入到新位置
            currentHistory.splice(targetIndex, 0, draggedChat);
            
            // 重新显示列表
            sortAndDisplayHistory();
            
            // 发送新排序到扩展
            vscode.postMessage({
                type: 'reorderHistory',
                data: currentHistory.map(chat => chat.id)
            });
        }

        this.classList.remove('drag-over');
        return false;
    }

    // 拖拽结束
    function handleDragEnd(e) {
        // 移除所有拖拽样式
        const items = historyList.querySelectorAll('.history-item');
        items.forEach(item => {
            item.classList.remove('dragging');
            item.classList.remove('drag-over');
        });
        
        draggedItem = null;
        draggedIndex = -1;
    }

    // 初始加载
    vscode.postMessage({ type: 'refresh' });
})();



