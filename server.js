const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
app.use(cors());

// Aumentamos el límite para permitir recibir audio grabado del micrófono
app.use(express.json({ limit: '20mb' })); 

// ==========================================
// 1. EL INSTALADOR INTELIGENTE (CACHÉ SEGURO)
// ==========================================
const YTDLP_PATH = '/tmp/yt-dlp';
let isDownloading = false;
let downloadPromise = null;

async function ensureYtDlp() {
    // Si ya está instalado y pesa lo correcto (más de 15MB), no hace nada
    if (fs.existsSync(YTDLP_PATH)) {
        const stats = fs.statSync(YTDLP_PATH);
        if (stats.size > 15000000) return;
    }

    // Si ya se está descargando en otra petición, espera a que termine (Anti-corrupción)
    if (isDownloading) return downloadPromise;

    isDownloading = true;
    downloadPromise = (async () => {
        console.log("⚙️ Instalando motor yt-dlp en el servidor...");
        const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
        if (!response.ok) throw new Error("Error de conexión con GitHub");
        
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(YTDLP_PATH, Buffer.from(buffer));
        fs.chmodSync(YTDLP_PATH, '755'); // Permisos para ejecutar
        
        isDownloading = false;
        console.log("✅ Instalación completada y guardada en caché.");
    })();
    
    await downloadPromise;
}

// Función auxiliar para ejecutar yt-dlp de forma segura
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && !stdout) reject(error || stderr);
            else resolve(stdout);
        });
    });
}


// ==========================================
// 2. SISTEMA DE RESPALDO (SI YT-DLP FALLA)
// ==========================================
const INVIDIOUS_INSTANCES = [
    "https://vid.puffyan.us",
    "https://inv.tux.pizza",
    "https://invidious.flokinet.to",
    "https://invidious.asir.dev"
];

const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.smnz.de",
    "https://api.piped.projectsegfau.lt"
];

// Carrera para búsquedas
async function searchWithApis(query) {
    const invPromises = INVIDIOUS_INSTANCES.map(instance => 
        new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.length > 0) {
                        return resolve(data.map(i => ({
                            id: i.videoId,
                            title: i.title,
                            author: i.author,
                            thumb: i.videoThumbnails && i.videoThumbnails.length > 0 ? i.videoThumbnails[0].url : `https://i.ytimg.com/vi/${i.videoId}/mqdefault.jpg`,
                            duration: i.lengthSeconds
                        })));
                    }
                }
                reject();
            } catch(e) { reject(); }
        })
    );

    const pipedPromises = PIPED_INSTANCES.map(instance => 
        new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=all`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.ok) {
                    const data = await res.json();
                    if (data.items && data.items.length > 0) {
                        return resolve(data.items.filter(i => i.type === 'stream').map(i => ({
                            id: i.url.split('v=')[1] || i.url.split('/').pop(),
                            title: i.title,
                            author: i.uploaderName,
                            thumb: i.thumbnail,
                            duration: i.duration
                        })));
                    }
                }
                reject();
            } catch(e) { reject(); }
        })
    );

    return await Promise.any([...invPromises, ...pipedPromises]);
}

// Carrera para extracción de enlaces
async function getFastestStream(videoId, isAudio) {
    // ... Misma lógica rápida de carrera del código anterior
    const pipedPromises = PIPED_INSTANCES.map(instance => 
        new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`${instance}/streams/${videoId}`, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (res.ok) {
                    const data = await res.json();
                    if (isAudio && data.audioStreams?.length > 0) {
                        const bestAudio = data.audioStreams.find(s => s.format === "M4A") || data.audioStreams[0];
                        return resolve(bestAudio.url);
                    }
                    if (!isAudio && data.videoStreams?.length > 0) {
                        const bestVideo = data.videoStreams.find(s => !s.videoOnly) || data.videoStreams[0];
                        return resolve(bestVideo.url);
                    }
                }
                reject();
            } catch(e) { reject(); }
        })
    );
    try { return await Promise.any(pipedPromises); } 
    catch (error) { return null; }
}


// ==========================================
// 3. ENDPOINTS PRINCIPALES DE LA API
// ==========================================

// Mostrar la interfaz web
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// BÚSQUEDA
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Falta la búsqueda" });

    try {
        // Plan A: Usar el instalador local (yt-dlp)
        await ensureYtDlp();
        const stdout = await runYtDlp([`ytsearch20:${query}`, '--dump-json', '--flat-playlist']);
        
        const lines = stdout.trim().split('\n');
        const results = lines.map(line => {
            try { return JSON.parse(line); } catch(e) { return null; }
        }).filter(item => item && item.id).map(i => ({
            id: i.id,
            title: i.title,
            author: i.uploader || i.channel,
            thumb: `https://i.ytimg.com/vi/${i.id}/mqdefault.jpg`,
            duration: i.duration
        }));

        res.json(results);
    } catch (error) {
        // Plan B: Si yt-dlp falla, usar las APIs públicas
        console.log("yt-dlp falló, usando Plan B (APIs)...");
        try {
            const apiResults = await searchWithApis(query);
            res.json(apiResults);
        } catch (apiError) {
            res.status(500).json({ error: "Servidores ocupados." });
        }
    }
});

// EXTRAER AUDIO
app.get('/api/audio', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    try {
        await ensureYtDlp();
        const stdout = await runYtDlp(['-f', 'bestaudio', '--get-url', `https://www.youtube.com/watch?v=${videoId}`]);
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) return res.json({ url });
        throw new Error("URL inválida");
    } catch (error) {
        const url = await getFastestStream(videoId, true);
        if (url) res.json({ url });
        else res.status(500).json({ error: "Bloqueado por YouTube" });
    }
});

// EXTRAER VIDEO
app.get('/api/video', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    try {
        await ensureYtDlp();
        const stdout = await runYtDlp(['-f', 'best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`]);
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) return res.json({ url });
        throw new Error("URL inválida");
    } catch (error) {
        const url = await getFastestStream(videoId, false);
        if (url) res.json({ url });
        else res.status(500).json({ error: "Bloqueado por YouTube" });
    }
});

// RECONOCIMIENTO SHAZAM
app.post('/api/recognize', async (req, res) => {
    try {
        const { audioBase64 } = req.body;
        if (!audioBase64) return res.status(400).json({ error: "Sin audio" });
        const formData = new URLSearchParams();
        formData.append('audio', audioBase64);
        formData.append('api_token', 'test');
        const response = await fetch('https://api.audd.io/', { method: 'POST', body: formData });
        const data = await response.json();
        if (data && data.status === "success" && data.result) {
            res.json({ title: data.result.title, artist: data.result.artist });
        } else {
            res.status(404).json({ error: "No encontrada" });
        }
    } catch (error) {
        res.status(500).json({ error: "Error de servidor" });
    }
});

module.exports = app;