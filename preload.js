const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
    selectFile: () => ipcRenderer.invoke('dialog:select-file'),
    
    // NUEVO: Diálogo de guardar
    saveFile: () => ipcRenderer.invoke('dialog:save-file'),
    
    countPhotos: (folder) => ipcRenderer.invoke('util:count-photos', folder),
    generateVideoMultiAudio: (data) => ipcRenderer.invoke('action:generate-multi', data),
    onProgress: (callback) => ipcRenderer.on('conversion:progress', (_event, value) => callback(value)),
    cancelGeneration: () => ipcRenderer.invoke('action:cancel')
});