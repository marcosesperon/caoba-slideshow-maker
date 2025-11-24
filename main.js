const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const execOptions = { maxBuffer: 1024 * 1024 * 200 }; 

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); 
const ffprobePath = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');;

let mainWindow;
let currentFFmpegProcess = null;
let isCancelled = false;


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 520, height: 700, // Un poco más de altura para el nuevo campo
        autoHideMenuBar: true,
        resizable: false,
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

function getJpgFiles(folder) {
    try {
        // 1. Leemos todos los archivos de la carpeta
        const allFiles = fs.readdirSync(folder);

        // 2. Aplicamos el filtro
        return allFiles.filter(file => {
            // Condición A: Debe terminar en .jpg o .JPG
            const isJpgExtension = file.toLowerCase().endsWith('.jpg');
            
            // Condición B: NO debe empezar por "._" (archivos de metadatos de macOS)
            // Tampoco debería empezar por "." en general (archivos ocultos del sistema como .DS_Store)
            const isHiddenOrMetadata = file.startsWith('.');

            // El archivo es válido si cumple A y NO cumple B
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

// --- MANEJADORES ---
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

// NUEVO: Manejador para el diálogo "Guardar como..."
ipcMain.handle('dialog:save-file', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Guardar Video Final',
        defaultPath: 'caoba_slideshow.mp4',
        filters: [{ name: 'Video MP4', extensions: ['mp4'] }]
    });
    // Si el usuario cancela, filePath es undefined, devolvemos null
    return result.canceled ? null : result.filePath;
});


ipcMain.handle('util:count-photos', async (event, folder) => {
    return getJpgFiles(folder).length;
});

ipcMain.handle('action:cancel', async () => {
    if (currentFFmpegProcess && currentFFmpegProcess.pid) {
        console.log(`Solicitada cancelación forzada del PID: ${currentFFmpegProcess.pid}`);
        isCancelled = true;
        if (process.platform === 'win32') {
            try {
                spawn('taskkill', ['/pid', currentFFmpegProcess.pid, '/f', '/t']);
            } catch (e) {
                currentFFmpegProcess.kill(); 
            }
        } else {
            currentFFmpegProcess.kill('SIGKILL');
        }
    }
    return true;
});


// ==================================================================
//  MOTOR CENTRAL V8 (CON RUTA DE DESTINO PERSONALIZADA)
// ==================================================================
// Ahora recibimos 'destinationPath'
ipcMain.handle('action:generate-multi', async (event, { folder, musicData, durationPerPhoto, useVisualTransition, videoFormat, destinationPath }) => {
    return new Promise(async (resolve) => { 
        
        currentFFmpegProcess = null;
        isCancelled = false;

        const outputFile = destinationPath;
        // Archivos temporales
        const listFileSimple = path.join(folder, 'temp_input_list.txt');
        // NUEVO: Archivo temporal para argumentos largos
        const argsFileComplex = path.join(folder, 'temp_ffmpeg_args.txt');

        // Limpieza inicial
        if (fs.existsSync(outputFile)) try { fs.unlinkSync(outputFile); } catch(e){}
        if (fs.existsSync(listFileSimple)) try { fs.unlinkSync(listFileSimple); } catch(e){}
        if (fs.existsSync(argsFileComplex)) try { fs.unlinkSync(argsFileComplex); } catch(e){}

        try {
            const files = getJpgFiles(folder);
            if (files.length < 2) throw new Error("Se necesitan al menos 2 imágenes");

            // === DEFINIR RESOLUCIÓN OBJETIVO ===
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
                    let startTimeSec = 0; let duration = 0;
                    try { duration = await getAudioDuration(track.path); } catch (e) { throw new Error(`Error leyendo pista ${i+1}.`); }
                    if (track.mode === 'manual') { startTimeSec = track.startPhotoIndex * secPerPhoto; } 
                    else { startTimeSec = Math.max(0, currentAudioTailTime - audioCrossfadeDuration); }
                    currentAudioTailTime = startTimeSec + duration;
                    calculatedMusicData.push({ path: track.path, startTimeSec: startTimeSec });
                }
            }

            if (isCancelled) throw new Error("Cancelado por el usuario.");

            // BIFURCACIÓN: MODO SIMPLE vs COMPLEJO
            if (!hasAudio && !useVisualTransition) {
                console.log(">>> USANDO MODO SIMPLE (ATAJO) <<<");
                let fileContent = '';
                files.forEach((file) => {
                    const fullPath = path.join(folder, file).replace(/\\/g, '/');
                    fileContent += `file '${fullPath}'\nduration ${secPerPhoto}\n`;
                });
                const lastPath = path.join(folder, files[files.length-1]).replace(/\\/g, '/');
                fileContent += `file '${lastPath}'\n`;
                fs.writeFileSync(listFileSimple, fileContent);

                const cmdString = `"${ffmpegPath}" -y -f concat -safe 0 -i "${listFileSimple}" -vf "scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -pix_fmt yuv420p -shortest "${outputFile}"`;
                                
                console.log("Iniciando FFmpeg (Modo Simple)...");
                currentFFmpegProcess = spawn(cmdString, { shell: true });

            } else {
                console.log(">>> USANDO MODO COMPLEJO (FILTER_COMPLEX) <<<");
                let inputStr = ""; let filterComplex = "";
                const videoInputCount = files.length;
                const d_show = secPerPhoto + videoTransDuration; 
                                
                // Usamos path.posix.join y .replace para asegurar barras inclinadas (/) incluso en Windows,
                // ya que funcionan mejor dentro de archivos de argumentos de FFmpeg.
                const normalizePath = (p) => p.split(path.sep).join('/');

                files.forEach(file => { 
                    inputStr += ` -loop 1 -t ${d_show} -i "${normalizePath(path.join(folder, file))}"`; 
                });
                if (hasAudio) { 
                    calculatedMusicData.forEach((track) => { 
                        inputStr += ` -stream_loop -1 -i "${normalizePath(track.path)}"`; 
                    }); 
                }

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
                            const startTimeSec = currentTrackMeta.startTimeSec;
                            const currentAudioInputStr = `[${videoInputCount + i}:a]`;
                            const nextLabel = (i === audioInputsCount - 1) ? `[aFinalAudio]` : `[aMix${i}]`;
                            const trimDuration = startTimeSec + audioCrossfadeDuration;
                            filterComplex += `${previousAudioLabel}atrim=duration=${trimDuration},asetpts=PTS-STARTPTS[aTrimmed${i}];`;
                            filterComplex += `[aTrimmed${i}]${currentAudioInputStr}acrossfade=d=${audioCrossfadeDuration}${nextLabel};`;
                            previousAudioLabel = nextLabel;
                        }
                    }
                }
                if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);

                const audioMapCmd = hasAudio ? '-map "[aFinalAudio]"' : '';
                
                // ===== NUEVO: TÉCNICA @FILE PARA COMANDOS LARGOS =====
                                
                // 1. Construimos el string GIGANTE de solo argumentos (sin el ejecutable ffmpeg delante)
                const argsOnlyString = `-y ${inputStr} -filter_complex "${filterComplex}" -map "[vFinalVideo]" ${audioMapCmd} -c:v libx264 -pix_fmt yuv420p -t ${totalVideoDuration} "${normalizePath(outputFile)}"\n`;

                // 2. Lo escribimos en un archivo temporal
                fs.writeFileSync(argsFileComplex, argsOnlyString);

                console.log("Comando largo detectado. Usando archivo de argumentos (@file).");
                console.log("Archivo de argumentos guardado en:", argsFileComplex);

                // 3. Ejecutamos FFmpeg pasándole solo el archivo con @
                // IMPORTANTE: shell: false aquí es más seguro y directo
                currentFFmpegProcess = spawn(ffmpegPath, ['@' + argsFileComplex], { shell: false });
            }

            /*currentFFmpegProcess.stderr.on('data', (data) => {
                const text = data.toString();
                const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (match && match[1]) {
                    const currentSeconds = timeToSeconds(match[1]);
                    const percent = (currentSeconds / totalVideoDuration) * 100;
                    mainWindow.webContents.send('conversion:progress', Math.min(Math.round(percent), 99));
                }
            });

            currentFFmpegProcess.on('close', (code) => {
                console.log(`Proceso FFmpeg terminado con código: ${code}`);
                currentFFmpegProcess = null;
                if (fs.existsSync(listFile)) try { fs.unlinkSync(listFile); } catch(e){}

                if (isCancelled) {
                    resolve({ success: false, error: "Cancelado por el usuario." });
                } else if (code === 0) {
                    // Devolvemos la ruta final que eligió el usuario
                    resolve({ success: true, path: outputFile });
                } else {
                    resolve({ success: false, error: "Error en el renderizado. Revisa la consola." });
                }
            });*/

            // NUEVO: Variable para guardar TODO el log de errores
            let fullErrorLog = ""; 

            currentFFmpegProcess.stderr.on('data', (data) => {
                const text = data.toString();
                
                // NUEVO: Acumulamos el texto en nuestra variable de log
                fullErrorLog += text + "\n"; 

                // (El código de la barra de progreso sigue igual)
                const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (match && match[1]) {
                    const currentSeconds = timeToSeconds(match[1]);
                    const percent = (currentSeconds / totalVideoDuration) * 100;
                    mainWindow.webContents.send('conversion:progress', Math.min(Math.round(percent), 99));
                }
            });

            currentFFmpegProcess.on('close', (code) => {
                console.log(`Proceso FFmpeg terminado con código: ${code}`);
                currentFFmpegProcess = null;
                if (fs.existsSync(listFileSimple)) try { fs.unlinkSync(listFileSimple); } catch(e){}
                if (fs.existsSync(argsFileComplex)) try { fs.unlinkSync(argsFileComplex); } catch(e){}

                if (isCancelled) {
                    resolve({ success: false, error: "Cancelado por el usuario." });
                } else if (code === 0) {
                    resolve({ success: true, path: outputFile });
                } else {
                    // === AQUÍ ESTÁ LA CLAVE ===
                    // Si el código NO es 0, imprimimos el log completo que hemos guardado
                    console.error("---------------------------------------------------");
                    console.error("!!! ERROR FATAL DE FFMPEG !!!");
                    console.error("Aquí está el log completo para que veas el error real:");
                    console.error(fullErrorLog);
                    console.error("---------------------------------------------------");
                    
                    // Devolvemos un mensaje genérico al usuario, pero nosotros miramos la consola
                    resolve({ success: false, error: "Error técnico en el motor de video. Revisa la consola de desarrollador para ver los detalles." });
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