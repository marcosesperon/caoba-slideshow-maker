const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
// NUEVO: Importar exif-parser
const exifParser = require('exif-parser');

const execOptions = { maxBuffer: 1024 * 1024 * 500 }; 

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); 
const ffprobePath = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');;

let mainWindow;
let currentFFmpegProcess = null;
let isCancelled = false;

// NUEVO: Variable global para almacenar la lista de archivos ORDENADA
let currentSortedFiles = [];
// Variable para recordar la carpeta actual (para el CWD de FFmpeg)
let currentFolderRoot = "";


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 520, height: 700,
        resizable: false,
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

// --- UTILIDADES ---
function timeToSeconds(timeString) {
    const parts = timeString.split(':');
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

// NUEVO: Función auxiliar para obtener la fecha de captura (EXIF o Sistema)
function getFileCreationDate(filePath) {
    try {
        // 1. Intentamos leer EXIF (es síncrono, rápido para archivos locales)
        const buffer = fs.readFileSync(filePath);
        const parser = exifParser.create(buffer);
        const result = parser.parse();
        
        // DateTimeOriginal es la fecha de captura real. CreateDate es secundaria.
        // exif-parser devuelve timestamps en segundos, multiplicamos por 1000 para JS.
        const exifTimestamp = result.tags.DateTimeOriginal || result.tags.CreateDate;
        
        if (exifTimestamp) {
            return new Date(exifTimestamp * 1000);
        }
    } catch (e) {
        // Si falla EXIF (no tiene metadatos o no es un JPG estándar), ignoramos y seguimos.
    }

    // 2. Fallback: Usar fechas del sistema de archivos
    const stats = fs.statSync(filePath);
    // 'birthtime' es fecha de creación (mejor), 'mtime' es modificación (peor caso)
    return stats.birthtime || stats.mtime;
}


// Función auxiliar básica para obtener solo los nombres (usada internamente por el escaneador)
function getRawJpgFilenames(folder) {
    try {
        const allFiles = fs.readdirSync(folder);
        return allFiles.filter(file => {
            const isJpgExtension = file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg');
            const isHiddenOrMetadata = file.startsWith('.');
            return isJpgExtension && !isHiddenOrMetadata;
        });
    } catch (e) {
        console.error("Error leyendo directorio:", e);
        return []; 
    }
}

function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        execFile(ffprobePath, [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ], (error, stdout, stderr) => {
            if (error) reject(error);
            else {
                const duration = parseFloat(stdout);
                if (isNaN(duration)) reject(new Error("No se pudo leer duración"));
                else resolve(duration);
            }
        });
    });
}

// --- MANEJADORES IPC ---

ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return result.filePaths[0];
});

ipcMain.handle('dialog:select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        filters: [{ name: 'Audio MP3', extensions: ['mp3'] }],
        properties: ['openFile']
    });
    return result.filePaths[0];
});

ipcMain.handle('dialog:save-file', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Guardar Video Final',
        defaultPath: 'mi_slideshow.mp4',
        filters: [{ name: 'Video MP4', extensions: ['mp4'] }]
    });
    return result.canceled ? null : result.filePath;
});

// NUEVO: Manejador principal para ESCANEAR Y ORDENAR
ipcMain.handle('util:scan-and-sort', async (event, folder, sortMode) => {
    currentFolderRoot = folder; // Guardamos la raíz para luego
    const rawFilenames = getRawJpgFilenames(folder);
    
    if (rawFilenames.length < 2) {
        currentSortedFiles = [];
        return 0;
    }

    console.log(`Escaneando ${rawFilenames.length} fotos. Modo: ${sortMode}`);

    if (sortMode === 'name') {
        // Ordenación alfabética simple (insensible a mayúsculas)
        currentSortedFiles = rawFilenames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } else if (sortMode === 'date') {
        // Ordenación por fecha (EXIF preferente)
        // Creamos un array temporal de objetos { nombre, fecha } para ordenar eficientemente
        const filesWithDate = rawFilenames.map(filename => ({
            name: filename,
            date: getFileCreationDate(path.join(folder, filename))
        }));

        // Ordenamos basándonos en el objeto Date (de más antiguo a más nuevo)
        filesWithDate.sort((a, b) => a.date - b.date);

        // Extraemos solo los nombres ya ordenados
        currentSortedFiles = filesWithDate.map(f => f.name);
    }
    
    // Devolvemos los ficheros para que el frontend lo sepa
    return currentSortedFiles;
});


ipcMain.handle('action:cancel', async () => {
    if (currentFFmpegProcess && currentFFmpegProcess.pid) {
        console.log(`Solicitada cancelación forzada del PID: ${currentFFmpegProcess.pid}`);
        isCancelled = true;
        if (process.platform === 'win32') {
            try { spawn('taskkill', ['/pid', currentFFmpegProcess.pid, '/f', '/t']); } catch (e) { currentFFmpegProcess.kill(); }
        } else {
            currentFFmpegProcess.kill('SIGKILL');
        }
    }
    return true;
});


// ==================================================================
//  MOTOR CENTRAL V11 (USA LA LISTA PRE-ORDENADA)
// ==================================================================
// Nota: Ya no recibimos 'folder' en los argumentos, usamos las variables globales.
ipcMain.handle('action:generate-multi', async (event, { musicData, durationPerPhoto, useVisualTransition, videoFormat, destinationPath }) => {
    return new Promise(async (resolve) => { 
        
        currentFFmpegProcess = null;
        isCancelled = false;
        
        // Usamos las variables globales llenadas en el paso anterior
        const folder = currentFolderRoot;
        // CAMBIO CLAVE: Usamos la lista que ya ordenamos previamente
        const files = currentSortedFiles; 

        const outputFile = destinationPath;
        const filterScriptFile = path.join(folder, 'temp_filter_script.txt');

        if (fs.existsSync(outputFile)) try { fs.unlinkSync(outputFile); } catch(e){}
        if (fs.existsSync(filterScriptFile)) try { fs.unlinkSync(filterScriptFile); } catch(e){}

        try {
            // Validación de seguridad por si acaso
            if (!folder || files.length < 2) throw new Error("Error de estado: No hay archivos seleccionados u ordenados.");

            let targetW, targetH;
            switch (videoFormat) {
                case '916_v': targetW = 1080; targetH = 1920; break;
                case '45_v':  targetW = 1080; targetH = 1350; break;
                case '23_v':  targetW = 1280; targetH = 1920; break;
                case '45_h':  targetW = 1350; targetH = 1080; break;
                case '23_h':  targetW = 1920; targetH = 1280; break;
                case '169_h': default: targetW = 1920; targetH = 1080; break;
            }
            
            const hasAudio = musicData && musicData.length > 0;
            const secPerPhoto = parseFloat(durationPerPhoto);
            const videoTransDuration = useVisualTransition ? 1.0 : 0; 
            const totalVideoDuration = useVisualTransition 
                ? (files.length * secPerPhoto) + videoTransDuration 
                : files.length * secPerPhoto;
            
            const audioCrossfadeDuration = 3; 
            let calculatedMusicData = [];
            
            // FASE 0: PRE-CÁLCULO AUDIO
            if (hasAudio) {
                console.log("--- Iniciando pre-cálculo de audio ---");
                let currentAudioTailTime = 0; 
                for (let i = 0; i < musicData.length; i++) {
                    if (isCancelled) throw new Error("Cancelado por el usuario.");
                    const track = musicData[i];
                    let duration = 0;
                    try { duration = await getAudioDuration(track.path); } catch (e) { throw new Error(`Error leyendo pista ${i+1}.`); }
                    let startTimeSec = (track.mode === 'manual') ? track.startPhotoIndex * secPerPhoto : Math.max(0, currentAudioTailTime - audioCrossfadeDuration);
                    currentAudioTailTime = startTimeSec + duration;
                    calculatedMusicData.push({ path: track.path, startTimeSec: startTimeSec });
                }
            }

            if (isCancelled) throw new Error("Cancelado por el usuario.");

            // ==================================================================
            // CONSTRUCCIÓN DEL COMANDO
            // ==================================================================
            console.log(`>>> GENERANDO COMANDO CON ${files.length} FOTOS ORDENADAS <<<`);
            
            let inputStr = ""; 
            let filterComplex = "";
            const videoInputCount = files.length;
            const d_show = secPerPhoto + videoTransDuration; 
            
            const normalizeForCmd = (p) => p.split(path.sep).join('/');

            // 1. INPUTS DE VIDEO (Usando la lista 'files' que ya está ordenada)
            files.forEach(file => { 
                inputStr += ` -loop 1 -t ${d_show} -i "${file}"`; 
            });

            // 2. INPUTS DE AUDIO
            if (hasAudio) { 
                calculatedMusicData.forEach((track) => { 
                    inputStr += ` -stream_loop -1 -i "${normalizeForCmd(track.path)}"`; 
                }); 
            }

            // 3. CONSTRUIR EL GRAFO DE FILTROS (Igual que antes)
            for (let i = 0; i < videoInputCount; i++) { 
                filterComplex += `[${i}]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p[vPre${i}];`; 
            }
            if (useVisualTransition) {
                let offset = secPerPhoto;
                for (let i = 0; i < videoInputCount - 1; i++) {
                    const input1 = (i === 0) ? `[vPre0]` : `[vMix${i}]`; const input2 = `[vPre${i+1}]`; const output = (i === files.length - 2) ? `[vFinalVideo]` : `[vMix${i+1}]`;
                    filterComplex += `${input1}${input2}xfade=transition=fade:duration=${videoTransDuration}:offset=${offset}${output};`;
                    offset += secPerPhoto;
                }
            } else {
                for (let i = 0; i < videoInputCount; i++) { filterComplex += `[vPre${i}]`; }
                filterComplex += `concat=n=${videoInputCount}:v=1:a=0[vFinalVideo];`;
            }

            if (hasAudio) {
                let audioInputsCount = calculatedMusicData.length;
                if (audioInputsCount === 1) { filterComplex += `[${videoInputCount}:a]anull[aFinalAudio];`; } else {
                    let previousAudioLabel = `[${videoInputCount}:a]`; 
                    for (let i = 1; i < audioInputsCount; i++) {
                        const currentTrackMeta = calculatedMusicData[i];
                        const nextLabel = (i === audioInputsCount - 1) ? `[aFinalAudio]` : `[aMix${i}]`;
                        const trimDuration = currentTrackMeta.startTimeSec + audioCrossfadeDuration;
                        filterComplex += `${previousAudioLabel}atrim=duration=${trimDuration},asetpts=PTS-STARTPTS[aTrimmed${i}];`;
                        filterComplex += `[aTrimmed${i}][${videoInputCount + i}:a]acrossfade=d=${audioCrossfadeDuration}${nextLabel};`;
                        previousAudioLabel = nextLabel;
                    }
                }
            }
            if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);


            // GUARDAR SCRIPT
            fs.writeFileSync(filterScriptFile, filterComplex, { encoding: 'utf8' });

            const audioMapCmd = hasAudio ? '-map "[aFinalAudio]"' : '';
            
            // COMANDO FINAL
            const cmdString = `"${ffmpegPath}" -y ${inputStr} -filter_complex_script "${normalizeForCmd(filterScriptFile)}" -map "[vFinalVideo]" ${audioMapCmd} -c:v libx264 -pix_fmt yuv420p -t ${totalVideoDuration} "${normalizeForCmd(outputFile)}"`;

            console.log("Iniciando FFmpeg (con CWD y lista ordenada)...");
            console.log("Comando: ", cmdString);
            
            currentFFmpegProcess = spawn(cmdString, { 
                shell: true,
                cwd: folder // Usamos la carpeta raíz guardada
            });


            // --- MANEJO COMÚN DE SALIDA Y ERRORES (MEJORADO) ---
            currentFFmpegProcess.stderr.on('data', (data) => {
                const text = data.toString();
                // Buscamos el tiempo actual en el log de FFmpeg
                const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (match && match[1]) {
                    const currentSeconds = timeToSeconds(match[1]);
                    let percent = (currentSeconds / totalVideoDuration) * 100;
                    percent = Math.min(Math.round(percent), 99); // Limitar a 99%

                    // === NUEVO: CÁLCULO DEL FICHERO ACTUAL ===
                    // Calculamos el índice aproximado basado en el progreso actual.
                    // Usamos Math.floor para obtener el índice entero (0, 1, 2...).
                    let currentIndex = Math.floor((currentSeconds / totalVideoDuration) * files.length);
                    
                    // Aseguramos que el índice no se salga del array (por si el tiempo se pasa un poco)
                    currentIndex = Math.min(currentIndex, files.length - 1);
                    
                    // Obtenemos el nombre del fichero usando la lista ordenada 'files'
                    // Usamos path.basename para mostrar solo "foto.jpg" y no toda la ruta "C:/Users/..."
                    const currentFileName = path.basename(files[currentIndex]);

                    // CAMBIO IMPORTANTE: Ahora enviamos un OBJETO con dos datos
                    mainWindow.webContents.send('conversion:progress', {
                        percent: percent,
                        file: currentFileName
                    });
                    // ==========================================
                }
            });

            currentFFmpegProcess.on('close', (code) => {
                console.log(`Proceso FFmpeg terminado con código: ${code}`);
                currentFFmpegProcess = null;
                if (fs.existsSync(filterScriptFile)) try { fs.unlinkSync(filterScriptFile); } catch(e){}

                if (isCancelled) {
                    resolve({ success: false, error: "Cancelado por el usuario." });
                } else if (code === 0) {
                    resolve({ success: true, path: outputFile });
                } else {
                    resolve({ success: false, error: "Error técnico en el motor de video. Revisa la consola de desarrollo para detalles." });
                }
            });

            currentFFmpegProcess.on('error', (err) => {
                 if (!isCancelled) resolve({ success: false, error: err.message });
            });

        } catch (err) {
            currentFFmpegProcess = null;
            resolve({ success: false, error: err.message });
        }
    });
});