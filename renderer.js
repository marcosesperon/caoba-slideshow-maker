const btnFolder = document.getElementById('btnSelectFolder');
// NUEVO: Botón de destino
const btnSelectDest = document.getElementById('btnSelectDest'); 
const btnAddMusic = document.getElementById('btnAddMusic');
const btnGenerate = document.getElementById('btnGenerate');
const btnCancel = document.getElementById('btnCancel'); 
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const musicListDiv = document.getElementById('musicList');
const photoCountInfo = document.getElementById('photoCountInfo');
const destPathInput = document.getElementById('destPath');
const sortOptionsDiv = document.getElementById('sortOptions');
const sortRadioButtons = document.querySelectorAll('input[name="sortMode"]');
const fileListContainer = document.getElementById('fileListContainer');
const fileListPreview = document.getElementById('fileListPreview');

const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');

let totalPhotos = 0;
let musicTracks = []; 
let isGenerating = false; 
let currentFolderPath = "";

// --- FUNCIONES DE INTERFAZ ---
// NUEVO: Función para renderizar la lista de archivos en el DOM
function renderFilePreview(filesList) {
    fileListPreview.innerHTML = ''; // Limpiar anterior

    if (!filesList || filesList.length === 0) {
        fileListContainer.style.display = 'none';
        return;
    }

    // Usamos un DocumentFragment para mejorar el rendimiento al insertar muchos elementos
    const fragment = document.createDocumentFragment();

    filesList.forEach((fileName, index) => {
        const row = document.createElement('div');
        // Estilo de fila alterno para facilitar la lectura
        row.style.padding = '3px 5px';
        if (index % 2 === 0) row.style.backgroundColor = '#fff';
        
        // Formato: "1. nombre_archivo.jpg"
        // Usamos padStart para alinear los números (001, 002...) si hay muchas fotos
        const indexStr = (index + 1).toString().padStart(filesList.length.toString().length, '0');
        
        row.innerText = `${indexStr}. ${fileName}`;
        fragment.appendChild(row);
    });

    fileListPreview.appendChild(fragment);
    fileListContainer.style.display = 'block';
    // Scroll al principio
    fileListPreview.scrollTop = 0;
}

function addMusicRow(filePath, isFirst = false) {
    const rowId = Date.now();
    const row = document.createElement('div');
    row.className = 'music-row';
    row.id = `music-row-${rowId}`;

    let optionsHTML = `
        <div class="radio-group text-xs">
            <label class="flex items-center"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Empieza al inicio del video</label>
        </div>`;

    if (!isFirst) {
        optionsHTML = `
        <div class="radio-group text-xs">
          <div class="flex">
            <label class="radio-option">
                <input type="radio" class="radio" name="start-mode-${rowId}" value="auto" checked onchange="togglePhotoInput(${rowId}, false)">
                <span>Justo después de la anterior (con disolvencia)</span>
            </label>
            </div>
            <div class="flex items-center justify-between">
              <label class="radio-option">
                  <input type="radio" class="radio" name="start-mode-${rowId}" value="manual" onchange="togglePhotoInput(${rowId}, true)">
                  <span>A partir de una foto específica</span>
              </label>
              <div class="photo-select-container ml-2" id="photo-input-container-${rowId}" style="display:none;">
                  <input type="number" class="input photo-select start-photo-input" min="2" max="${totalPhotos}" value="${Math.min(2, totalPhotos)}" placeholder="Foto #">
              </div>
            </div>
        </div>`;
    }

    row.innerHTML = `
    <div class="card bg-base-100 w-100 shadow-sm mb-2"><div class="card-body">
        <div class="flex music-info">
            <input type="text" class="input grow music-path" value="${filePath}" readonly title="${filePath}">
            ${!isFirst ? `<button class="btn btn-square btn-sm ml-2 mt-1" onclick="removeMusicTrack(${rowId})"><svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12" />
          </svg></button>` : ''}
        </div>
        <div class="music-options">
            ${optionsHTML}
        </div>
    </div></div>`;

    musicListDiv.appendChild(row);
    musicTracks.push({ id: rowId, path: filePath });
    updateUIState();
}

window.togglePhotoInput = (rowId, show) => {
    const container = document.getElementById(`photo-input-container-${rowId}`);
    if (container) container.style.display = show ? 'block' : 'none';
};

window.removeMusicTrack = (idToRemove) => {
    if (isGenerating) return; 
    musicTracks = musicTracks.filter(track => track.id !== idToRemove);
    document.getElementById(`music-row-${idToRemove}`).remove();
    updateUIState();
};

function updateUIState() {
    const hasDest = destPathInput.value.trim() !== '';
    btnAddMusic.disabled = totalPhotos === 0 || isGenerating;
    // CAMBIO: Ahora requiere fotos Y destino
    btnGenerate.disabled = totalPhotos === 0 || !hasDest || isGenerating;
    document.querySelectorAll('.btn-delete').forEach(btn => btn.disabled = isGenerating);
    btnSelectDest.disabled = isGenerating;
    btnFolder.disabled = isGenerating;
    sortRadioButtons.forEach(radio => radio.disabled = isGenerating);
}

// renderer.js

// NUEVO: Función centralizada para escanear fotos (VERSIÓN ROBUSTA CON TRY/CATCH)
async function scanPhotosInFolder(folderPath) {
    if (!folderPath) return;
    currentFolderPath = folderPath;
    document.getElementById('folderPath').value = folderPath;
    
    statusText.innerText = "Analizando y ordenando fotos...";
    statusDiv.className = "alert alert-soft";
    photoCountInfo.innerText = "⏳ Escaneando...";
    
    // Deshabilitamos opciones mientras escanea
    sortRadioButtons.forEach(radio => radio.disabled = true);

    renderFilePreview([]);

    try {
        // Obtenemos el modo de ordenación actual
        // (Si es la primera vez, cogerá el que esté 'checked' por defecto en el HTML)
        const sortModeElement = document.querySelector('input[name="sortMode"]:checked');
        const sortMode = sortModeElement ? sortModeElement.value : 'name';

        // --- PUNTO CRÍTICO: Aquí es donde se quedaba colgado ---
        // Intentamos la llamada, y si falla, saltamos al 'catch'
        const sortedFilesList = await window.api.scanAndSortFiles(folderPath, sortMode);
        totalPhotos = sortedFilesList.length;

        // Si llegamos aquí, todo ha ido bien
        if (totalPhotos < 2) {
            photoCountInfo.innerText = `Se encontraron ${totalPhotos} fotos válidas. Se necesitan al menos 2.`;
            photoCountInfo.className = "text-error";
            totalPhotos = 0;
            sortOptionsDiv.style.display = "none"; 
            renderFilePreview([]);
        } else {
            photoCountInfo.innerText = `${totalPhotos} fotos válidas (Ordenado por: ${sortMode === 'name' ? 'Nombre' : 'Fecha'}).`;
            photoCountInfo.className = "text-success"; 
            sortOptionsDiv.style.display = "flex"; 
            renderFilePreview(sortedFilesList);
        }
        statusText.innerText = "";
        statusDiv.className = "hidden";

    } catch (error) {
        // --- CAPTURA DEL ERROR ---
        console.error("Error durante el escaneo:", error);
        photoCountInfo.innerText = "Error al analizar la carpeta.";
        photoCountInfo.className = "text-error"; 
        statusText.innerText = `Error técnico:\n${error.message}`;
        statusDiv.className = "alert alert-soft alert-error";
        totalPhotos = 0;
        sortOptionsDiv.style.display = "none";
        renderFilePreview([]);
    } finally {
        // Pase lo que pase, reactivamos los controles de UI
        sortRadioButtons.forEach(radio => radio.disabled = false);
        updateUIState();
    }
}

// --- EVENT LISTENERS ---

btnCancel.addEventListener('click', async () => {
    if (!isGenerating) return;
    btnCancel.disabled = true;
    btnCancel.innerHTML = 'Cancelando...';
    statusText.innerHTML = "Intentando detener el proceso...";
    statusDiv.className = "alert alert-soft alert-warning";
    await window.api.cancelGeneration();
});

btnFolder.addEventListener('click', async () => {
    if (isGenerating) return;
    const path = await window.api.selectFolder();
    if (path) {
        musicListDiv.innerHTML = ''; musicTracks = [];
        if (!destPathInput.value) {
             const isWin = navigator.userAgent.includes('Windows'); const sep = isWin ? '\\' : '/';
             destPathInput.value = path + sep + "caoba_slideshow.mp4";
        }
        // Usamos la nueva función centralizada
        scanPhotosInFolder(path);
    }
});

// NUEVO: Listener para cambio de ordenación
sortRadioButtons.forEach(radio => {
    radio.addEventListener('change', () => {
        if (currentFolderPath && !isGenerating) {
            // Si cambiamos el radio, re-escaneamos la carpeta actual
            scanPhotosInFolder(currentFolderPath);
        }
    });
});

// NUEVO: Listener para el botón de destino
btnSelectDest.addEventListener('click', async () => {
    if (isGenerating) return;
    // Invocamos la nueva función del API
    const path = await window.api.saveFile();
    if (path) {
        destPathInput.value = path;
        updateUIState();
    }
});

btnAddMusic.addEventListener('click', async () => {
    if (isGenerating) return;
    const path = await window.api.selectFile();
    if (path) addMusicRow(path, musicTracks.length === 0);
});

window.api.onProgress((data) => {
    // 1. Actualizamos la barra como siempre
    progressBar.value = data.percent;
    progressText.innerText = Math.round(data.percent) + "%";

    // 2. NUEVO: Actualizamos el texto de estado con el fichero
    // Usamos un icono de reloj de arena para indicar proceso
    statusText.innerText = `⏳ Procesando imagen: ${data.file}`;
});

btnGenerate.addEventListener('click', async () => {
    const folder = document.getElementById('folderPath').value;
    const durationPerPhoto = document.getElementById('duration').value;
    const useVisualTransition = document.getElementById('chkTransition').checked;
    const videoFormat = document.getElementById('videoFormat').value;
    // NUEVO: Capturar el destino
    const destinationPath = destPathInput.value;

    if (!destinationPath) { statusText.innerText = "Selecciona un destino."; return; }

    let finalMusicData = [];
    for (let i = 0; i < musicTracks.length; i++) {
        const track = musicTracks[i];
        const row = document.getElementById(`music-row-${track.id}`);
        let trackData = { path: track.path };
        if (i === 0) {
            trackData.mode = 'manual'; trackData.startPhotoIndex = 0;
        } else {
            const mode = row.querySelector(`input[name="start-mode-${track.id}"]:checked`).value;
            trackData.mode = mode;
            if (mode === 'manual') {
                const val = parseInt(row.querySelector('.start-photo-input').value);
                if (isNaN(val) || val < 1 || val > totalPhotos) {
                    statusText.innerText = `Error pista ${i+1}: Foto inválida.`; return;
                }
                trackData.startPhotoIndex = val - 1; 
            }
        }
        finalMusicData.push(trackData);
    }

    isGenerating = true;
    updateUIState(); 

    statusText.innerText = musicTracks.length > 0 ? "⏳ Analizando audio y preparando mezcla..." : "⏳ Preparando video (sin audio)...";
    statusDiv.className = "alert alert-soft";
    progressBar.value = 0; 
    btnCancel.style.display = "block"; 
    btnCancel.disabled = false;
    btnCancel.innerHTML = 'Cancelar';

    // Enviamos la nueva propiedad 'destinationPath'
    const result = await window.api.generateVideoMultiAudio({
        musicData: finalMusicData, 
        durationPerPhoto,
        useVisualTransition,
        videoFormat,
        destinationPath // <--- AÑADIDO
    });

    isGenerating = false;
    updateUIState(); 
    btnCancel.style.display = "none";

    if (result.success) {
        // Usamos la ruta real de destino en el mensaje de éxito
        statusText.innerText = `🎉 ¡Video completado!\n${result.path}`;
        statusDiv.className = "alert alert-soft alert-success";
        progressBar.value = 100;
        progressText.innerText = "100%";
    } else {
        statusText.innerText = `${result.error}`;
        statusDiv.className = (result.error.includes("Cancelado") ? "alert alert-soft alert-warning" : "alert alert-soft alert-error");
        if (result.error.includes("Cancelado")) progressBar.value = 0;
    }
});

updateUIState();