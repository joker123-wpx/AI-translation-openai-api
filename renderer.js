const { ipcRenderer, clipboard } = require('electron');

let config = { apiUrl: '', apiKey: '', modelName: 'gpt-3.5-turbo', targetLang: 'English' };
let isMonitoring = false;
let chatHistory = [];
let savedChats = [];  // 保存的历史对话
let currentChatId = null;  // 当前对话ID
let lastTranslatedText = '';
let shouldReplace = false;
let lastTranslatedSource = '';  // 记录上次翻译的原文，防止重复翻译
let isTranslating = false;  // 防止并发翻译

const $ = id => document.getElementById(id);

const els = {
  btnTop: $('btn-top'), btnSettings: $('btn-settings'), btnMin: $('btn-min'), btnClose: $('btn-close'),
  btnCloseSettings: $('btn-close-settings'), settingsPanel: $('settings-panel'),
  tabs: document.querySelectorAll('.tab'), panels: document.querySelectorAll('.panel'),
  targetLang: $('target-lang'), apiStatus: $('api-status'), btnMonitor: $('btn-monitor'),
  monitorText: $('monitor-text'), autoReplace: $('auto-replace'),
  originalText: $('original-text'), translatedText: $('translated-text'),
  btnCopyResult: $('btn-copy-result'), btnReplace: $('btn-replace'),
  monitorModeContent: $('monitor-mode-content'), translateModeContent: $('translate-mode-content'),
  inputText: $('input-text'), outputText: $('output-text'), btnTranslate: $('btn-translate'),
  btnCopy: $('btn-copy'), btnPaste: $('btn-paste'),
  chatMessages: $('chat-messages'), chatInput: $('chat-input'),
  btnChatImage: $('btn-chat-image'), btnSend: $('btn-send'), btnNewChat: $('btn-new-chat'),
  chatHistoryDropdown: $('chat-history-dropdown'),
  apiUrl: $('api-url'), apiKey: $('api-key'), modelName: $('model-name'),
  btnTest: $('btn-test'), testResult: $('test-result'), btnSave: $('btn-save'),
  fileInput: $('file-input')
};

async function init() {
  const saved = await ipcRenderer.invoke('get-config');
  if (saved) {
    config = { ...config, ...saved };
    els.apiUrl.value = config.apiUrl || '';
    els.apiKey.value = config.apiKey || '';
    els.modelName.value = config.modelName || 'gpt-3.5-turbo';
    els.targetLang.value = config.targetLang || 'English';
    // 加载保存的对话历史
    savedChats = config.savedChats || [];
  }
  if (config.apiUrl && config.apiKey) testConnection(true);
  bindEvents();
}

function bindEvents() {
  els.btnTop.onclick = async () => {
    const isTop = await ipcRenderer.invoke('toggle-top');
    els.btnTop.style.opacity = isTop ? '1' : '0.4';
  };
  els.btnSettings.onclick = () => els.settingsPanel.classList.add('show');
  els.btnCloseSettings.onclick = () => els.settingsPanel.classList.remove('show');
  els.btnMin.onclick = () => ipcRenderer.invoke('minimize-window');
  els.btnClose.onclick = () => ipcRenderer.invoke('close-window');

  els.tabs.forEach(tab => {
    tab.onclick = () => {
      els.tabs.forEach(t => t.classList.remove('active'));
      els.panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.tab}`).classList.add('active');
    };
  });

  els.targetLang.onchange = e => { 
    config.targetLang = e.target.value; 
    saveConfig(); 
    // 重置翻译状态，允许重新翻译同一段文本
    lastTranslatedSource = '';
    lastTranslatedText = '';
  };
  els.btnMonitor.onclick = toggleMonitor;

  // 代码块事件委托
  document.addEventListener('click', (e) => {
    // 复制按钮
    const copyBtn = e.target.closest('.code-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      const id = copyBtn.dataset.id;
      copyCode(id);
      return;
    }
    // 展开/折叠按钮
    const expandBtn = e.target.closest('.code-expand-btn');
    if (expandBtn) {
      e.stopPropagation();
      const id = expandBtn.dataset.id;
      toggleCode(id);
      return;
    }
    // 点击 header 也可以切换
    const header = e.target.closest('.code-header');
    if (header && !e.target.closest('.code-copy-btn')) {
      const id = header.dataset.id;
      toggleCode(id);
    }
  });
  
  els.btnCopyResult.onclick = () => {
    if (lastTranslatedText) { clipboard.writeText(lastTranslatedText); showToast('已复制'); }
  };
  
  els.btnReplace.onclick = async () => {
    if (lastTranslatedText) {
      const result = await ipcRenderer.invoke('paste-text', lastTranslatedText);
      showToast(result.success ? '已替换' : '替换失败');
    }
  };

  // 翻译面板事件
  els.btnTranslate.onclick = () => manualTranslate();
  els.inputText.onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); manualTranslate(); } };
  if (els.btnPaste) els.btnPaste.onclick = async () => { els.inputText.value = clipboard.readText(); };
  if (els.btnCopy) els.btnCopy.onclick = () => {
    const text = els.outputText.textContent;
    if (text) { clipboard.writeText(text); showToast('已复制'); }
  };

  els.btnSend.onclick = sendChat;
  els.chatInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
  els.btnChatImage.onclick = () => els.fileInput.click();
  els.fileInput.onchange = handleImage;
  els.btnNewChat.onclick = newChat;
  els.btnNewChat.oncontextmenu = showChatHistory;
  
  // 点击其他地方关闭历史下拉菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#chat-history-dropdown') && !e.target.closest('#btn-new-chat')) {
      els.chatHistoryDropdown.classList.remove('show');
    }
  });
  
  els.btnTest.onclick = () => testConnection(false);
  els.btnSave.onclick = saveSettings;

  ipcRenderer.on('clipboard-changed', (_, text) => {
    if (isMonitoring && text && text.trim()) translateText(text, els.autoReplace.checked);
  });
  ipcRenderer.on('translate-text', (_, text, replace) => translateText(text, replace));
  ipcRenderer.on('translate-clipboard', (_, text) => translateText(text, false));
  ipcRenderer.on('translate-and-replace', (_, text) => translateAndReplace(text));
}

function toggleMonitor() {
  isMonitoring = !isMonitoring;
  if (isMonitoring) {
    els.btnMonitor.classList.add('active');
    els.monitorText.textContent = '监控中...';
    els.monitorModeContent.style.display = 'block';
    els.translateModeContent.style.display = 'none';
    ipcRenderer.send('start-monitor');
  } else {
    els.btnMonitor.classList.remove('active');
    els.monitorText.textContent = '开启监控';
    els.monitorModeContent.style.display = 'none';
    els.translateModeContent.style.display = 'block';
    ipcRenderer.send('stop-monitor');
  }
}

async function translateText(text, autoReplace = false) {
  if (!text.trim()) return;
  // 防止重复翻译同一段文本
  if (text === lastTranslatedSource || text === lastTranslatedText) return;
  if (isTranslating) return;
  
  isTranslating = true;
  lastTranslatedSource = text;
  els.originalText.textContent = text;
  els.translatedText.innerHTML = '<span class="loading"></span>翻译中...';
  shouldReplace = autoReplace;
  
  try {
    const prompt = `将以下文本翻译成${config.targetLang}，只返回翻译结果：\n\n${text}`;
    const result = await callAPI([{ role: 'user', content: prompt }]);
    lastTranslatedText = result;
    els.translatedText.innerHTML = formatContent(result);
    updateStatus('connected');
    if (shouldReplace) {
      const r = await ipcRenderer.invoke('paste-text', result);
      if (r.success) showToast('已自动替换');
    }
  } catch (err) {
    els.translatedText.textContent = '翻译失败: ' + err.message;
    updateStatus('error');
  } finally {
    isTranslating = false;
  }
}

// 手动翻译（翻译面板）
async function manualTranslate() {
  const text = els.inputText.value.trim();
  if (!text) return;
  if (isTranslating) return;
  
  isTranslating = true;
  els.outputText.innerHTML = '<span class="loading"></span>翻译中...';
  
  try {
    const prompt = `将以下文本翻译成${config.targetLang}，只返回翻译结果：\n\n${text}`;
    const result = await callAPI([{ role: 'user', content: prompt }]);
    els.outputText.innerHTML = formatContent(result);
    updateStatus('connected');
  } catch (err) {
    els.outputText.textContent = '翻译失败: ' + err.message;
    updateStatus('error');
  } finally {
    isTranslating = false;
  }
}

// 流式翻译并实时替换
async function translateAndReplace(text) {
  if (!text.trim()) return;
  // 防止重复翻译
  if (text === lastTranslatedSource || text === lastTranslatedText) return;
  if (isTranslating) return;
  
  isTranslating = true;
  lastTranslatedSource = text;
  els.originalText.textContent = text;
  els.translatedText.innerHTML = '<span class="loading"></span>翻译中...';
  
  try {
    // 标记开始流式替换（暂停剪贴板监控）
    await ipcRenderer.invoke('stream-replace-start');
    
    const prompt = `将以下文本翻译成${config.targetLang}，只返回翻译结果：\n\n${text}`;
    let fullResult = '';
    
    // 先删除原文
    await ipcRenderer.invoke('delete-original', text.length);
    
    await streamAPI([{ role: 'user', content: prompt }], (chunk) => {
      fullResult += chunk;
      els.translatedText.textContent = fullResult;
      
      // 异步输入chunk，不等待
      ipcRenderer.invoke('type-chunk', chunk);
    });
    
    // 翻译结束，等待所有chunk输入完成并恢复剪贴板
    await ipcRenderer.invoke('stream-replace-end');
    
    lastTranslatedText = fullResult;
    els.translatedText.innerHTML = formatContent(fullResult);
    updateStatus('connected');
    showToast('翻译完成');
  } catch (err) {
    // 出错也要结束流式替换
    await ipcRenderer.invoke('stream-replace-end');
    els.translatedText.textContent = '翻译失败: ' + err.message;
    updateStatus('error');
  } finally {
    isTranslating = false;
  }
}

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  els.chatInput.value = '';
  chatHistory.push({ role: 'user', content: text });
  const msgDiv = addMessage('assistant', '');
  msgDiv.classList.add('typing-cursor');
  try {
    await streamAPI(chatHistory, (chunk) => {
      msgDiv.classList.remove('typing-cursor');
      const cur = msgDiv.getAttribute('data-raw') || '';
      const newC = cur + chunk;
      msgDiv.setAttribute('data-raw', newC);
      msgDiv.innerHTML = formatContent(newC);
      msgDiv.classList.add('typing-cursor');
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    });
    msgDiv.classList.remove('typing-cursor');
    chatHistory.push({ role: 'assistant', content: msgDiv.getAttribute('data-raw') || '' });
  } catch (err) {
    msgDiv.classList.remove('typing-cursor');
    msgDiv.textContent = '错误: ' + err.message;
  }
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (content) div.innerHTML = formatContent(content);
  els.chatMessages.appendChild(div);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return div;
}

function newChat() {
  // 保存当前对话（如果有内容）
  if (chatHistory.length > 0) {
    saveCurrentChat();
  }
  // 创建新对话
  currentChatId = Date.now();
  chatHistory = [];
  els.chatMessages.innerHTML = '';
  showToast('已新建对话');
}

// 保存当前对话到历史
function saveCurrentChat() {
  if (chatHistory.length === 0) return;
  
  // 获取对话标题（第一条用户消息的前20个字符）
  const firstUserMsg = chatHistory.find(m => m.role === 'user');
  const title = firstUserMsg ? firstUserMsg.content.slice(0, 20) + (firstUserMsg.content.length > 20 ? '...' : '') : '新对话';
  
  // 检查是否已存在该对话
  const existingIndex = savedChats.findIndex(c => c.id === currentChatId);
  const chatData = {
    id: currentChatId || Date.now(),
    title,
    time: new Date().toLocaleString('zh-CN'),
    history: [...chatHistory],
    messages: els.chatMessages.innerHTML
  };
  
  if (existingIndex >= 0) {
    savedChats[existingIndex] = chatData;
  } else {
    savedChats.unshift(chatData);
  }
  
  // 最多保存10条历史
  if (savedChats.length > 10) {
    savedChats = savedChats.slice(0, 10);
  }
  
  // 保存到配置
  config.savedChats = savedChats;
  saveConfig();
}

// 显示历史对话下拉菜单
function showChatHistory(e) {
  e.preventDefault();
  
  if (savedChats.length === 0) {
    els.chatHistoryDropdown.innerHTML = '<div class="chat-history-empty">暂无历史对话</div>';
  } else {
    els.chatHistoryDropdown.innerHTML = savedChats.map(chat => `
      <div class="chat-history-item" data-id="${chat.id}">
        <div class="chat-history-info">
          <div class="chat-history-title">${escapeHtml(chat.title)}</div>
          <div class="chat-history-time">${chat.time}</div>
        </div>
        <button class="chat-history-delete" data-id="${chat.id}" title="删除">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');
  }
  
  els.chatHistoryDropdown.classList.toggle('show');
  
  // 绑定点击事件
  els.chatHistoryDropdown.querySelectorAll('.chat-history-item').forEach(item => {
    item.onclick = (e) => {
      if (e.target.closest('.chat-history-delete')) return;
      const id = parseInt(item.dataset.id);
      restoreChat(id);
    };
  });
  
  els.chatHistoryDropdown.querySelectorAll('.chat-history-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      deleteChat(id);
    };
  });
}

// 恢复历史对话
function restoreChat(id) {
  // 先保存当前对话
  if (chatHistory.length > 0 && currentChatId !== id) {
    saveCurrentChat();
  }
  
  const chat = savedChats.find(c => c.id === id);
  if (chat) {
    currentChatId = chat.id;
    chatHistory = [...chat.history];
    els.chatMessages.innerHTML = chat.messages;
    els.chatHistoryDropdown.classList.remove('show');
    showToast('已恢复对话');
  }
}

// 删除历史对话
function deleteChat(id) {
  savedChats = savedChats.filter(c => c.id !== id);
  config.savedChats = savedChats;
  saveConfig();
  
  // 刷新下拉菜单
  if (savedChats.length === 0) {
    els.chatHistoryDropdown.innerHTML = '<div class="chat-history-empty">暂无历史对话</div>';
  } else {
    showChatHistory({ preventDefault: () => {} });
  }
  showToast('已删除');
}

function formatContent(text) {
  if (!text) return '';
  text = text.trim();  // 去掉开头和结尾的空白
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let result = text, blocks = [], match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    blocks.push({ full: match[0], lang: match[1] || 'code', code: match[2] });
  }
  blocks.forEach((b, i) => {
    const id = `cb-${Date.now()}-${i}`;
    const codeLines = b.code.trim().split('\n');
    const lineCount = codeLines.length;
    const hl = highlightCode(b.code.trim());
    const html = `<div class="code-block" id="${id}">
      <div class="code-header">
        <span class="code-lang">${b.lang} (${lineCount} lines)</span>
        <div class="code-actions">
          <span class="code-lines">+${lineCount} lines</span>
          <button class="code-copy">Copy</button>
        </div>
      </div>
      <div class="code-content"><pre>${hl}</pre></div>
    </div>`;
    result = result.replace(b.full, html);
  });
  result = result.replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');
  result = result.replace(/\n/g, '<br>');
  return result;
}

function highlightCode(code) {
  let e = escapeHtml(code);
  e = e.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|new|this|true|false|null|undefined|def|print|self)\b/g, '<span class="keyword">$1</span>');
  e = e.replace(/("[^"]*"|'[^']*')/g, '<span class="string">$1</span>');
  e = e.replace(/\b(\d+\.?\d*)\b/g, '<span class="number">$1</span>');
  e = e.replace(/(\/\/.*|#.*)/g, '<span class="comment">$1</span>');
  e = e.replace(/\b([a-zA-Z_]\w*)\s*\(/g, '<span class="function">$1</span>(');
  return e;
}

function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// 使用事件委托处理代码块点击（避免 CSP 问题）
document.addEventListener('click', (e) => {
  // 处理复制按钮
  const copyBtn = e.target.closest('.code-copy');
  if (copyBtn) {
    e.stopPropagation();
    const block = copyBtn.closest('.code-block');
    if (block) {
      const code = block.querySelector('pre').textContent;
      clipboard.writeText(code);
      showToast('已复制');
    }
    return;
  }
  
  // 处理展开/折叠（点击 header）
  const header = e.target.closest('.code-header');
  if (header) {
    const block = header.closest('.code-block');
    if (block) block.classList.toggle('collapsed');
  }
});

async function callAPI(messages) {
  if (!config.apiUrl || !config.apiKey) throw new Error('请先配置API');
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.modelName, messages })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

async function streamAPI(messages, onChunk) {
  if (!config.apiUrl || !config.apiKey) throw new Error('请先配置API');
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.modelName, messages, stream: true })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const d = line.slice(6);
        if (d === '[DONE]') return;
        try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) onChunk(c); } catch {}
      }
    }
  }
}

function handleImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    const b64 = ev.target.result;
    const img = document.createElement('div');
    img.className = 'message user';
    img.innerHTML = `<img src="${b64}" style="max-width:100%;border-radius:8px;">`;
    els.chatMessages.appendChild(img);
    try {
      const r = await callAPI([{ role: 'user', content: [{ type: 'text', text: '描述这张图片' }, { type: 'image_url', image_url: { url: b64 } }] }]);
      addMessage('assistant', r);
    } catch { addMessage('assistant', '图片处理失败'); }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function testConnection(silent) {
  const url = els.apiUrl.value || config.apiUrl;
  const key = els.apiKey.value || config.apiKey;
  const model = els.modelName.value || config.modelName;
  if (!url || !key) { if (!silent) { els.testResult.textContent = '请填写API信息'; els.testResult.className = 'error'; } updateStatus('error'); return; }
  if (!silent) { els.testResult.textContent = '测试中...'; els.testResult.className = ''; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }) });
    if (res.ok) { if (!silent) { els.testResult.textContent = '✓ 连接成功'; els.testResult.className = 'success'; } updateStatus('connected'); }
    else throw new Error(`HTTP ${res.status}`);
  } catch (err) { if (!silent) { els.testResult.textContent = '✗ ' + err.message; els.testResult.className = 'error'; } updateStatus('error'); }
}

async function saveSettings() {
  config.apiUrl = els.apiUrl.value;
  config.apiKey = els.apiKey.value;
  config.modelName = els.modelName.value;
  await saveConfig();
  els.settingsPanel.classList.remove('show');
  showToast('已保存');
  testConnection(true);
}

async function saveConfig() { await ipcRenderer.invoke('save-config', config); }
function updateStatus(s) { els.apiStatus.className = `status-dot ${s}`; }
function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2335;color:#c0caf5;padding:10px 20px;border-radius:8px;font-size:13px;z-index:1000;border:1px solid #292e42;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

init();
