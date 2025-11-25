const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
    selectFile: () => ipcRenderer.invoke('dialog:select-file'),
    saveFile: () => ipcRenderer.invoke('dialog:save-file'),
    
    scanAndSortFiles: (folder, sortMode) => ipcRenderer.invoke('util:scan-and-sort', folder, sortMode),
    
    generateVideoMultiAudio: (data) => ipcRenderer.invoke('action:generate-multi', data),
    onProgress: (callback) => ipcRenderer.on('conversion:progress', (_event, value) => callback(value)),
    cancelGeneration: () => ipcRenderer.invoke('action:cancel'),

    resizeImages: (folder, dimension, saveMode) => ipcRenderer.invoke('action:resize-images', folder, dimension, saveMode),
    onStatusUpdate: (callback) => ipcRenderer.on('status:update', (_event, data) => callback(data))
});

