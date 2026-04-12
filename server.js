const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // Permite peticiones desde tu Frontend

// Aumentamos el límite para permitir recibir fragmentos de audio
app.use(express.json({ limit: '20mb' })); 

// Ruta temporal donde Vercel permite guardar archivos
const YTDLP_PATH = '/tmp/yt-dlp';

// Función para asegurar que yt-dlp está descargado CORRECTAMENTE en Vercel
async function ensureYtDlp() {
    if (fs.existsSync(YTDLP_PATH)) {
        const stats = fs.statSync(YTDLP_PATH);
        if (stats.size > 15000000) {
            return;
        }
    }

    console.log("Descargando yt-dlp_linux (Standalone) en entorno Serverless...");
    const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    if (!response.ok) throw new Error(`Error HTTP al descargar: ${response.statusText}`);

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(YTDLP_PATH, Buffer.from(buffer));
    fs.chmodSync(YTDLP_PATH, '755');
    console.log("✅ yt-dlp_linux listo.");
}

// Endpoint base
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ENDPOINT: Búsqueda
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Falta la búsqueda" });

        await ensureYtDlp();

        execFile(YTDLP_PATH, [`ytsearch20:${query}`, '--dump-json', '--flat-playlist'], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && !stdout) {
                console.error("Error en búsqueda:", stderr || error.message);
                return res.status(500).json({ error: "Fallo en yt-dlp: " + (stderr || error.message) });
            }

            const lines = stdout.trim().split('\n');
            const results = lines.map(line => {
                try { return JSON.parse(line); } catch(e) { return null; }
            }).filter(item => item && item.id);

            res.json(results);
        });
    } catch (error) {
        res.status(500).json({ error: error.message || "Error inicializando entorno." });
    }
});

// ENDPOINT: Obtener URL del Audio (MP3/M4A)
app.get('/api/audio', async (req, res) => {
    try {
        const videoId = req.query.v;
        if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

        await ensureYtDlp();

        // Extraer mejor audio
        execFile(YTDLP_PATH, ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`], (error, stdout, stderr) => {
            if (error) return res.status(500).json({ error: "No se pudo extraer el audio" });
            res.json({ url: stdout.trim() });
        });
    } catch (error) {
        res.status(500).json({ error: "Error en el servidor." });
    }
});

// ENDPOINT: Obtener URL del Video (MP4)
app.get('/api/video', async (req, res) => {
    try {
        const videoId = req.query.v;
        if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

        await ensureYtDlp();

        // Extraer formato MP4 con audio y video combinados
        execFile(YTDLP_PATH, ['-f', 'best[ext=mp4]/best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`], (error, stdout, stderr) => {
            if (error) return res.status(500).json({ error: "No se pudo extraer el video" });
            res.json({ url: stdout.trim() });
        });
    } catch (error) {
        res.status(500).json({ error: "Error en el servidor." });
    }
});

// ENDPOINT: Reconocimiento de Música (Estilo Shazam)
app.post('/api/recognize', async (req, res) => {
    try {
        const { audioBase64 } = req.body;
        if (!audioBase64) return res.status(400).json({ error: "No se recibió audio." });

        const formData = new URLSearchParams();
        formData.append('audio', audioBase64);
        formData.append('api_token', 'test'); // Token público de prueba de AudD API

        const response = await fetch('https://api.audd.io/', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data && data.status === "success" && data.result) {
            res.json({
                title: data.result.title,
                artist: data.result.artist
            });
        } else {
            res.status(404).json({ error: "No se pudo reconocer la canción. Intenta acercarte más a la música." });
        }
    } catch (error) {
        res.status(500).json({ error: "Error en el servidor de reconocimiento." });
    }
});

module.exports = app;