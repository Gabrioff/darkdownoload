const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Aumentamos el límite para permitir recibir audio grabado
app.use(express.json({ limit: '20mb' })); 

const YTDLP_PATH = '/tmp/yt-dlp';

// 1. DESCARGA DE YT-DLP
async function ensureYtDlp() {
    if (fs.existsSync(YTDLP_PATH)) {
        const stats = fs.statSync(YTDLP_PATH);
        if (stats.size > 15000000) return;
    }
    console.log("Descargando yt-dlp_linux...");
    const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    if (!response.ok) throw new Error("Error HTTP");
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(YTDLP_PATH, Buffer.from(buffer));
    fs.chmodSync(YTDLP_PATH, '755');
}

// 2. SISTEMA ANTI-BLOQUEO (APIs de respaldo)
const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.smnz.de",
    "https://api.piped.projectsegfau.lt"
];

async function getFallbackStream(videoId, isAudio) {
    for (let instance of PIPED_INSTANCES) {
        try {
            // Timeout de 4 segundos por instancia
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(`${instance}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (res.ok) {
                const data = await res.json();
                if (isAudio && data.audioStreams?.length > 0) {
                    const bestAudio = data.audioStreams.find(s => s.format === "M4A") || data.audioStreams[0];
                    return bestAudio.url;
                }
                if (!isAudio && data.videoStreams?.length > 0) {
                    // Buscar el stream que tenga video Y audio integrado
                    const bestVideo = data.videoStreams.find(s => s.videoOnly === false) || data.videoStreams[0];
                    return bestVideo.url;
                }
            }
        } catch(e) {
            // Si una falla, pasa a la siguiente instancia automáticamente
            console.log(`Falló instancia ${instance}, probando otra...`);
        }
    }
    return null;
}

// ENDPOINT BASE: Mostrar la web
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ENDPOINT: Buscar Videos
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Falta la búsqueda" });

        await ensureYtDlp();

        execFile(YTDLP_PATH, [`ytsearch20:${query}`, '--dump-json', '--flat-playlist'], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && !stdout) {
                return res.status(500).json({ error: "Fallo en búsqueda" });
            }
            const lines = stdout.trim().split('\n');
            const results = lines.map(line => {
                try { return JSON.parse(line); } catch(e) { return null; }
            }).filter(item => item && item.id);
            res.json(results);
        });
    } catch (error) {
        res.status(500).json({ error: "Error en servidor" });
    }
});

// ENDPOINT: Extraer enlace de AUDIO
app.get('/api/audio', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    const handleFallback = async () => {
        const fallbackUrl = await getFallbackStream(videoId, true);
        if (fallbackUrl) return res.json({ url: fallbackUrl });
        return res.status(500).json({ error: "Bloqueado por YouTube" });
    };

    try {
        await ensureYtDlp();
        execFile(YTDLP_PATH, ['-f', 'bestaudio', '--get-url', `https://www.youtube.com/watch?v=${videoId}`], (error, stdout, stderr) => {
            if (!error && stdout) {
                // Toma solo la primera URL generada
                return res.json({ url: stdout.trim().split('\n')[0] });
            } else {
                handleFallback(); // Si YouTube lo bloqueó, activa el respaldo
            }
        });
    } catch (error) {
        handleFallback();
    }
});

// ENDPOINT: Extraer enlace de VIDEO
app.get('/api/video', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    const handleFallback = async () => {
        const fallbackUrl = await getFallbackStream(videoId, false);
        if (fallbackUrl) return res.json({ url: fallbackUrl });
        return res.status(500).json({ error: "Bloqueado por YouTube" });
    };

    try {
        await ensureYtDlp();
        execFile(YTDLP_PATH, ['-f', 'best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`], (error, stdout, stderr) => {
            if (!error && stdout) {
                return res.json({ url: stdout.trim().split('\n')[0] });
            } else {
                handleFallback(); // Si YouTube lo bloqueó, activa el respaldo
            }
        });
    } catch (error) {
        handleFallback();
    }
});

// ENDPOINT: Reconocimiento de Música (Shazam)
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