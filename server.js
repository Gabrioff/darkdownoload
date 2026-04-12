const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors()); // Permite peticiones desde tu Frontend

// Ruta temporal donde Vercel permite guardar archivos
const YTDLP_PATH = '/tmp/yt-dlp';

// Función para asegurar que yt-dlp está descargado en el servidor de Vercel
async function ensureYtDlp() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(YTDLP_PATH)) {
            return resolve();
        }

        console.log("Descargando yt-dlp en entorno Serverless...");
        const file = fs.createWriteStream(YTDLP_PATH);
        
        https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', function(response) {
            response.pipe(file);
            file.on('finish', function() {
                file.close();
                fs.chmodSync(YTDLP_PATH, '755'); // Dar permisos de ejecución
                console.log("✅ yt-dlp listo.");
                resolve();
            });
        }).on('error', function(err) {
            fs.unlink(YTDLP_PATH, () => {});
            reject(err);
        });
    });
}

// Endpoint base: Mostrar la interfaz visual bonita
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ENDPOINT: Búsqueda (Texto)
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Falta la búsqueda" });

        await ensureYtDlp();

        // Extraer 20 resultados en formato JSON
        const command = `${YTDLP_PATH} "ytsearch20:${query}" --dump-json --flat-playlist`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error("Error en búsqueda:", stderr);
                return res.status(500).json({ error: "Error ejecutando búsqueda" });
            }

            const lines = stdout.trim().split('\n');
            const results = lines.map(line => {
                try { return JSON.parse(line); } catch(e) { return null; }
            }).filter(item => item && item.id);

            res.json(results);
        });
    } catch (error) {
        res.status(500).json({ error: "Error inicializando entorno." });
    }
});

// ENDPOINT: Obtener Audio (Link o ID)
app.get('/api/audio', async (req, res) => {
    try {
        const videoId = req.query.v;
        if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

        await ensureYtDlp();

        // Extraer la URL del mejor audio disponible sin descargar el archivo
        const command = `${YTDLP_PATH} -f "bestaudio/best" --get-url "https://www.youtube.com/watch?v=${videoId}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Error obteniendo audio:", stderr);
                return res.status(500).json({ error: "No se pudo extraer el audio" });
            }
            res.json({ url: stdout.trim() });
        });
    } catch (error) {
        res.status(500).json({ error: "Error inicializando entorno." });
    }
});

// Exportar la app para que Vercel la ejecute como Serverless Function
module.exports = app;