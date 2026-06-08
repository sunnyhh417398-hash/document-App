'use strict';

/**
 * Electron 主程序：於本機啟動內建的公文系統伺服器，並以桌面視窗載入。
 * 重用既有的 server.js 與前端，資料儲存於作業系統的使用者資料夾。
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

// 將資料目錄指向使用者資料夾（避免寫入唯讀的安裝目錄）
process.env.DOCS_DATA_DIR = path.join(app.getPath('userData'), 'data');

let mainWindow = null;
let serverAddress = null;

async function ensureServer() {
  if (serverAddress) return serverAddress;
  const { start } = require('../server');
  // 0 = 由系統指派可用埠，僅綁定本機
  serverAddress = await start(0, '127.0.0.1');
  return serverAddress;
}

function buildMenu() {
  const template = [
    {
      label: '檔案',
      submenu: [
        {
          label: '開啟資料夾',
          click: () => shell.openPath(process.env.DOCS_DATA_DIR),
        },
        { type: 'separator' },
        { role: 'quit', label: '結束' },
      ],
    },
    {
      label: '編輯',
      submenu: [
        { role: 'undo', label: '復原' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪下' },
        { role: 'copy', label: '複製' },
        { role: 'paste', label: '貼上' },
        { role: 'selectAll', label: '全選' },
      ],
    },
    {
      label: '檢視',
      submenu: [
        { role: 'reload', label: '重新整理' },
        { role: 'forceReload', label: '強制重新整理' },
        { type: 'separator' },
        { role: 'resetZoom', label: '實際大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全螢幕' },
        { role: 'toggleDevTools', label: '開發者工具' },
      ],
    },
    {
      label: '說明',
      submenu: [
        {
          label: '關於公文系統',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '關於',
              message: '公文系統',
              detail: `公文製作 · 簽核流程 · 收發管理\n\n版本 ${app.getVersion()}\n服務位址 http://127.0.0.1:${serverAddress ? serverAddress.port : '—'}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '公文系統',
    backgroundColor: '#f4f6f9',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    const addr = await ensureServer();
    await mainWindow.loadURL(`http://127.0.0.1:${addr.port}`);
  } catch (err) {
    dialog.showErrorBox('啟動失敗', `無法啟動內建伺服器：\n${err.message}`);
    app.quit();
    return;
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部連結以系統瀏覽器開啟
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 單一執行個體
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
