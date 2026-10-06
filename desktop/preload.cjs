'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mathDesktop', {
  exportPdf: (title) => ipcRenderer.invoke('math:export-pdf', String(title || 'Документ')),
  prepareMedia: data => ipcRenderer.invoke('media:prepare', data),
  mediaVoices: () => ipcRenderer.invoke('media:voices'),
  mediaFrame: data => ipcRenderer.invoke('media:frame', data),
  finishMedia: id => ipcRenderer.invoke('media:finish', id),
  cancelMedia: id => ipcRenderer.invoke('media:cancel', id),
  audioDraftStatus: () => ipcRenderer.invoke('draft:status'),
  chooseDraftAudio: options => ipcRenderer.invoke('draft:choose',options),
  chooseDraftFolder: () => ipcRenderer.invoke('draft:folder'),
  writeDraftText: data => ipcRenderer.invoke('draft:write',data),
  transcribeDraft: data => ipcRenderer.invoke('draft:transcribe', data),
  cancelTranscription: () => ipcRenderer.invoke('draft:cancel'),
  onDraftProgress: listener => { const handler=(_event,data)=>listener(data); ipcRenderer.on('draft:progress',handler); return ()=>ipcRenderer.removeListener('draft:progress',handler); },
  onMediaProgress: listener => { const handler=(_event,data)=>listener(data); ipcRenderer.on('media:progress',handler); return ()=>ipcRenderer.removeListener('media:progress',handler); }
});
