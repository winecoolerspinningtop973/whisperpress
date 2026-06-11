'use strict';
const { BrowserWindow, screen, session, desktopCapturer, app } = require('electron');
const path = require('path');
const config = require('./config');

const ROOT = path.join(__dirname, '..', '..');
let mainWindow = null;
let overlayWindow = null;

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'audioCapture', 'display-capture'].includes(permission));
  });
  // System-audio loopback for meeting recording (Windows WASAPI loopback).
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0f0e14',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'assets', 'app.ico'),
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'main-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'main', 'index.html'));
  mainWindow.on('close', (e) => {
    if (config.get().closeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayWindow = new BrowserWindow({
    width: 380,
    height: 130,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'overlay.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function showOverlay() {
  const w = createOverlayWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  w.setBounds({
    x: Math.round(wa.x + (wa.width - 380) / 2),
    y: Math.round(wa.y + wa.height - 150),
    width: 380,
    height: 130,
  });
  if (!w.isVisible()) w.showInactive();
}
function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
}

function showMain(view) {
  const w = createMainWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (view) w.webContents.send('app:navigate', view);
}

function broadcast(channel, payload) {
  for (const w of [mainWindow, overlayWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

module.exports = {
  setupSession,
  createMainWindow,
  createOverlayWindow,
  showOverlay,
  hideOverlay,
  showMain,
  broadcast,
  get main() { return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null; },
  get overlay() { return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null; },
};
