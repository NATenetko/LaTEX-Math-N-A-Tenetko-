'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const entry = path.join(__dirname, '..', 'index.html');
const entryURL = pathToFileURL(entry).href;
const smokeIndex = process.argv.indexOf('--pdf-smoke');
const readerSmokeIndex = process.argv.indexOf('--reader-smoke');
const mediaSmokeIndex = process.argv.indexOf('--media-smoke');
const batchSmokeIndex = process.argv.indexOf('--batch-smoke');
const smokeDir = smokeIndex >= 0 ? process.argv[smokeIndex + 1]
  : readerSmokeIndex >= 0 ? process.argv[readerSmokeIndex + 1] : mediaSmokeIndex >= 0 ? process.argv[mediaSmokeIndex + 1] : batchSmokeIndex>=0?process.argv[batchSmokeIndex+1]:null;
if (smokeDir) app.setPath('userData', path.join(smokeDir, 'profile'));
app.setName('LaTEX Math Tenetko');
let mainWindow;
let exporting = false;
const mediaService=require('./media-export.cjs')({ipcMain,dialog,getWindow:()=>mainWindow,entryURL,smokeDir});
const draftService=require('./audio-draft.cjs')({ipcMain,dialog,getWindow:()=>mainWindow,entryURL,smokeDir:mediaSmokeIndex>=0 || batchSmokeIndex>=0?smokeDir:null});

ipcMain.handle('math:export-pdf', async (event, title) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame.url !== entryURL || exporting) {
    return { error: 'Недоступный запрос экспорта' };
  }
  exporting = true;
  try {
    const safeName = String(title).replace(/[\/\\:\x00-\x1f]/g, '_').slice(0, 100) || 'Документ';
    const style = smokeDir ? await event.sender.executeJavaScript(`document.querySelector('#print-view').dataset.pdfStyle`) : null;
    const result = smokeDir ? { filePath: path.join(smokeDir, `layout-${style}.pdf`) }
      : await dialog.showSaveDialog(mainWindow, {
        title: 'Сохранить PDF', defaultPath: `${safeName}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
    if (result.canceled || !result.filePath) return { cancelled: true };
    if (smokeDir) {
      const layout = await event.sender.executeJavaScript(`(() => {
        const root = document.querySelector('#print-view');
        return {
          text: root.textContent,
          style: root.dataset.pdfStyle,
          font: getComputedStyle(root).fontFamily,
          alignment: getComputedStyle(root.querySelector('p')).textAlign,
          formulas: [...root.querySelectorAll('.print-math[role="math"]')].map(node => node.getAttribute('aria-label')),
          fallbackCount: root.querySelectorAll('.print-math-fallback').length,
          mathErrors: root.querySelectorAll('[data-mml-node="merror"]').length,
          pages: [...root.querySelectorAll('.print-page-content')].map(page => ({
            height: page.clientHeight, scrollHeight: page.scrollHeight,
            used: page.lastElementChild ? page.lastElementChild.getBoundingClientRect().bottom - page.getBoundingClientRect().top : 0,
            headingsAtEnd: page.lastElementChild?.classList.contains('print-heading') || false
          }))
        };
      })()`);
      await fs.writeFile(path.join(smokeDir, `layout-${style}-report.json`), JSON.stringify(layout, null, 2));
    }
    const data = await event.sender.printToPDF({
      pageSize: 'A4', preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: false, margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    await fs.writeFile(result.filePath, data);
    return { cancelled: false };
  } catch (error) { return { error: error.message }; }
  finally { exporting = false; }
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900, minWidth: 850, minHeight: 600,
    title: 'LaTEX Math Tenetko', show: !smokeDir,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !smokeDir
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== entryURL) event.preventDefault();
  });
  // Projects are saved through the existing download-based JSON mechanism.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const draft=/\.txt$/i.test(item.getFilename());
    if(smokeDir) item.setSavePath(path.join(smokeDir,path.basename(item.getFilename())));
    else item.setSaveDialogOptions({ title: draft?'Сохранить черновик':'Сохранить проект', filters: [{ name: draft?'Text':'Math document', extensions: [draft?'txt':'json'] }] });
  });
  await mainWindow.loadFile(entry);
  mainWindow.on('closed',()=>{ mediaService.close(); draftService.close(); });
  if (smokeDir) {
    try { await require(readerSmokeIndex >= 0 ? './reader-smoke.cjs' : mediaSmokeIndex >= 0 ? './media-smoke.cjs' : batchSmokeIndex>=0?'./batch-smoke.cjs':'./pdf-smoke.cjs')(mainWindow, smokeDir); app.exit(0); }
    catch (error) { console.error(error); app.exit(1); }
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Вид', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Окно', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  createWindow().catch((error) => { console.error(error); app.exit(1); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
