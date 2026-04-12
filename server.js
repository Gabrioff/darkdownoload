const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); 

const YTDLP_PATH = '/tmp/yt-dlp';
let isDownloading = false;
let downloadPromise = null;

// INSTALADOR (Solo se usará para Búsquedas, ya no para descargas)
async function ensureYtDlp() {
    if (fs.existsSync(YTDLP_PATH)) {
        const stats = fs.statSync(YTDLP_PATH);
        if (stats.size > 15000000) return;
    }
    if (isDownloading) return downloadPromise;

    isDownloading = true;
    downloadPromise = (async () => {
        const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(YTDLP_PATH, Buffer.from(buffer));
        fs.chmodSync(YTDLP_PATH, '755');
        isDownloading = false;
    })();
    await downloadPromise;
}

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && !stdout) reject(error || stderr);
            else resolve(stdout);
        });
    });
}

// =========================================================
// EL ESCUDO MULTI-API (SISTEMA DE CARRERA PARA DESCARGAS)
// =========================================================
const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.smnz.de",
    "https://api.piped.projectsegfau.lt"
];

const INVIDIOUS_INSTANCES = [
    "https://vid.puffyan.us",
    "https://inv.tux.pizza"
];

async function getFastestStream(videoId, isAudio) {
    const promises = [];

    // 1. Instancias Piped
    PIPED_INSTANCES.forEach(instance => {
        promises.push(new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const res = await fetch(`${instance}/streams/${videoId}`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.ok) {
                    const data = await res.json();
                    if (isAudio && data.audioStreams?.length > 0) {
                        const bestAudio = data.audioStreams.find(s => s.format === "M4A") || data.audioStreams[0];
                        if (bestAudio.url) return resolve(bestAudio.url);
                    }
                    if (!isAudio && data.videoStreams?.length > 0) {
                        const bestVideo = data.videoStreams.find(s => !s.videoOnly) || data.videoStreams[0];
                        if (bestVideo.url) return resolve(bestVideo.url);
                    }
                }
                reject();
            } catch(e) { reject(); }
        }));
    });

    // 2. API Oculta de Respaldo (Muy rápida y sin bloqueos)
    promises.push(new Promise(async (resolve, reject) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch("https://co.wuk.sh/api/json", {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    isAudioOnly: isAudio,
                    aFormat: "mp3"
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (data && data.url) resolve(data.url);
            else reject();
        } catch(e) { reject(); }
    }));

    // 3. Instancias Invidious (Modo Proxy Local)
    INVIDIOUS_INSTANCES.forEach(instance => {
        promises.push(new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(`${instance}/api/v1/videos/${videoId}`, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (res.ok) {
                    // Crea un enlace proxy directo que burla la IP de YouTube
                    resolve(`${instance}/latest_version?id=${videoId}&itag=${isAudio ? '140' : '22'}&local=true`);
                } else {
                    reject();
                }
            } catch(e) { reject(); }
        }));
    });

    try {
        // Ejecuta las 6 conexiones a la vez, la primera en dar respuesta GANA.
        return await Promise.any(promises); 
    } 
    catch (error) { 
        return null; 
    }
}

// MOSTRAR WEB
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// BÚSQUEDA
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Falta búsqueda" });

    try {
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
        // Fallback de búsqueda si yt-dlp también es bloqueado
        res.status(500).json({ error: "Servidores ocupados temporalmente." });
    }
});

// DESCARGA DE AUDIO (Redirección Instántanea y Segura)
app.get('/api/download-audio', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).send("Falta ID del video");

    const url = await getFastestStream(videoId, true);
    if (url) return res.redirect(302, url);
    
    // Si los 6 servidores fallan a la vez (muy raro)
    res.status(500).send("Los servidores están saturados en este momento. Intenta de nuevo en un par de minutos.");
});

// DESCARGA DE VIDEO (Redirección Instántanea y Segura)
app.get('/api/download-video', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).send("Falta ID del video");

    const url = await getFastestStream(videoId, false);
    if (url) return res.redirect(302, url);
    
    // Si los 6 servidores fallan a la vez (muy raro)
    res.status(500).send("Los servidores están saturados en este momento. Intenta de nuevo en un par de minutos.");
});

// SHAZAM (Reconocimiento de audio)
app.post('/api/recognize', async (req, res) => {
    try {
        const { audioBase64 } = req.body;
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