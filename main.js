const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const Store = require('electron-store');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = new Store();
let mainWindow;
let tray;
let isAlwaysOnTop = true;
let isMonitoring = false;
let lastClipboardText = '';
let clipboardInterval = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minWidth: 320,
    minHeight: 400,
    icon: path.join(__dirname, 'icon', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  
  // 恢复窗口位置，确保不超出屏幕边界
  const bounds = store.get('windowBounds');
  if (bounds) {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    
    // 确保窗口顶部不超出屏幕（至少留出标题栏高度）
    if (bounds.y < 0) bounds.y = 0;
    if (bounds.x < -bounds.width + 100) bounds.x = 0;
    if (bounds.x > screenWidth - 100) bounds.x = screenWidth - bounds.width;
    if (bounds.y > screenHeight - 100) bounds.y = screenHeight - bounds.height;
    
    mainWindow.setBounds(bounds);
  }
  mainWindow.on('close', () => store.set('windowBounds', mainWindow.getBounds()));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('AI Translator');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow.show() },
    { label: '置顶', click: () => toggleAlwaysOnTop() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => mainWindow.show());
}

function toggleAlwaysOnTop() {
  isAlwaysOnTop = !isAlwaysOnTop;
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  return isAlwaysOnTop;
}

// 替换文本到当前焦点窗口 - 优化版本
async function replaceTextInFocusedWindow(originalText, newText) {
  return new Promise((resolve, reject) => {
    const savedClipboard = clipboard.readText();
    clipboard.writeText(newText);
    
    // 选中的文本直接按 Delete 删除，然后粘贴
    const script = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("{DELETE}");Start-Sleep -Milliseconds 30;[System.Windows.Forms.SendKeys]::SendWait("^v")`;
    
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    
    ps.on('close', (code) => {
      setTimeout(() => {
        clipboard.writeText(savedClipboard);
        // 更新 lastClipboardText，防止触发监控
        lastClipboardText = savedClipboard;
      }, 300);
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PowerShell exited with code ${code}`));
      }
    });
    
    ps.on('error', (err) => {
      reject(err);
    });
  });
}

// 使用选中文本方式替换（更可靠）- 优化版本
async function replaceSelectedText(newText) {
  return new Promise((resolve, reject) => {
    const savedClipboard = clipboard.readText();
    clipboard.writeText(newText);
    
    // 直接用 -Command，避免创建临时文件
    const script = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("^v")`;
    
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    
    ps.on('close', () => {
      setTimeout(() => {
        clipboard.writeText(savedClipboard);
        // 更新 lastClipboardText，防止触发监控
        lastClipboardText = savedClipboard;
      }, 200);
      resolve();
    });
    
    ps.on('error', reject);
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  
  // Ctrl+Shift+T: 翻译剪贴板/选中文本
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    const text = clipboard.readText();
    if (text) {
      mainWindow.webContents.send('translate-clipboard', text);
      mainWindow.show();
    }
  });
  
  // Ctrl+Shift+R: 翻译并替换（先复制选中文本，翻译后替换）
  globalShortcut.register('CommandOrControl+Shift+R', async () => {
    // 直接用 -Command 参数，更快
    const script = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("^c")`;
    
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    
    ps.on('close', () => {
      setTimeout(() => {
        const text = clipboard.readText();
        if (text && text.trim()) {
          mainWindow.webContents.send('translate-and-replace', text);
        }
      }, 150);
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipboardInterval) clearInterval(clipboardInterval);
});

// IPC handlers
ipcMain.handle('get-config', () => store.get('config', {}));
ipcMain.handle('save-config', (_, config) => { store.set('config', config); return true; });
ipcMain.handle('minimize-window', () => mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow.hide());
ipcMain.handle('toggle-top', () => toggleAlwaysOnTop());

// 替换文本
ipcMain.handle('replace-text', async (_, originalText, newText) => {
  try {
    await replaceTextInFocusedWindow(originalText, newText);
    return { success: true };
  } catch (err) {
    console.error('Replace failed:', err);
    return { success: false, error: err.message };
  }
});

// 直接粘贴（用于选中替换模式）
ipcMain.handle('paste-text', async (_, newText) => {
  try {
    await replaceSelectedText(newText);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 删除原文（用于流式替换的第一步）- 使用全选删除，更快
ipcMain.handle('delete-original', async (_, deleteCount) => {
  return new Promise((resolve) => {
    // 直接用 Ctrl+A 全选然后删除，比逐个退格快得多
    // 但如果只是选中的文本，用 Delete 键即可（选中状态下按任意键会替换）
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
`;
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    
    ps.on('close', () => resolve({ success: true }));
    ps.on('error', () => resolve({ success: false }));
  });
});

// 输入一个chunk（用于流式替换）- 使用剪贴板粘贴
let chunkQueue = [];
let isTyping = false;
let savedClipboard = '';
let isStreamReplacing = false;  // 标记是否正在流式替换

// 开始流式替换（暂停剪贴板监控）
ipcMain.handle('stream-replace-start', async () => {
  isStreamReplacing = true;
  savedClipboard = clipboard.readText();
  return { success: true };
});

// 结束流式替换（恢复剪贴板监控）
ipcMain.handle('stream-replace-end', async () => {
  // 等待队列处理完
  return new Promise((resolve) => {
    const checkDone = () => {
      if (!isTyping && chunkQueue.length === 0) {
        // 恢复剪贴板
        setTimeout(() => {
          if (savedClipboard) {
            clipboard.writeText(savedClipboard);
            // 更新监控的最后文本，避免触发翻译
            lastClipboardText = savedClipboard;
            savedClipboard = '';
          }
          isStreamReplacing = false;
        }, 100);
        resolve({ success: true });
      } else {
        setTimeout(checkDone, 50);
      }
    };
    checkDone();
  });
});

ipcMain.handle('type-chunk', async (_, chunk) => {
  chunkQueue.push(chunk);
  if (!isTyping) {
    processChunkQueue();
  }
  return { success: true };
});

function processChunkQueue() {
  if (isTyping || chunkQueue.length === 0) return;
  isTyping = true;
  
  // 合并所有待处理的chunks
  const allChunks = chunkQueue.join('');
  chunkQueue = [];
  
  clipboard.writeText(allChunks);
  
  // 直接用 -Command 参数，避免创建临时文件
  const script = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait("^v")`;
  
  const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
  
  ps.on('close', () => {
    isTyping = false;
    // 处理队列中新加入的chunks
    if (chunkQueue.length > 0) {
      setTimeout(processChunkQueue, 20);
    }
  });
}

// 开始监控
ipcMain.on('start-monitor', () => {
  if (isMonitoring) return;
  isMonitoring = true;
  lastClipboardText = clipboard.readText();
  
  clipboardInterval = setInterval(() => {
    // 流式替换过程中不触发翻译
    if (isStreamReplacing) return;
    
    const text = clipboard.readText();
    if (text && text !== lastClipboardText && text.trim()) {
      lastClipboardText = text;
      mainWindow.webContents.send('clipboard-changed', text);
    }
  }, 300);
});

ipcMain.on('stop-monitor', () => {
  isMonitoring = false;
  if (clipboardInterval) {
    clearInterval(clipboardInterval);
    clipboardInterval = null;
  }
});
