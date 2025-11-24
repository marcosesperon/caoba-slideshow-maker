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
const destPathInput = document.getElementById('destPath'); // NUEVO: Input destino

const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');

let totalPhotos = 0;
let musicTracks = []; 
let isGenerating = false; 

// --- FUNCIONES DE INTERFAZ ---

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
        document.getElementById('folderPath').value = path;
        statusText.innerHTML = "Analizando carpeta...";
        totalPhotos = await window.api.countPhotos(path);
        if (totalPhotos < 2) {
            photoCountInfo.innerText = `⚠️ Se encontraron ${totalPhotos} fotos. Se necesitan al menos 2.`;
            photoCountInfo.className = "text-error"; totalPhotos = 0;
        } else {
            photoCountInfo.innerText = `${totalPhotos} imágenes válidas encontradas.`;
            photoCountInfo.className = "text-accent"; 
        }
        musicListDiv.innerHTML = ''; musicTracks = [];
        
        // AUTO-SUGERENCIA: Al elegir carpeta, sugerimos un nombre de archivo ahí
        if (!destPathInput.value) {
             // Necesitamos una forma de obtener el separador de ruta del sistema (trick)
             const isWin = navigator.userAgent.includes('Windows');
             const sep = isWin ? '\\' : '/';
             // Ruta de carpeta + separador + nombre por defecto
             const suggestedPath = path + sep + "caoba_slideshow.mp4";
             destPathInput.value = suggestedPath;
        }
        
        updateUIState();
    }
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

window.api.onProgress((porcentaje) => {
    progressBar.value = porcentaje;
    progressText.innerText = Math.round(porcentaje) + "%";
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
        folder,
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
        statusText.innerText = `🎉 ¡Video completado!\nGuardado en:\n${result.path}`;
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