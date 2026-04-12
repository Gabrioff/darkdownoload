const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // Permite peticiones desde tu Frontend

// Ruta temporal donde Vercel permite guardar archivos
const YTDLP_PATH = '/tmp/yt-dlp';

// Función para asegurar que yt-dlp está descargado CORRECTAMENTE en Vercel
async function ensureYtDlp() {
    // Verificar si el archivo ya existe y si pesa lo correcto (más de 1MB)
    // Esto evita usar el archivo corrupto de 0 bytes del error anterior
    if (fs.existsSync(YTDLP_PATH)) {
        const stats = fs.statSync(YTDLP_PATH);
        if (stats.size > 1000000) {
            return;
        }
    }

    console.log("Descargando yt-dlp en entorno Serverless...");
    
    // Usamos 'fetch' nativo porque sí sigue las redirecciones de GitHub correctamente
    const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
    
    if (!response.ok) {
        throw new Error(`Error HTTP al descargar: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(YTDLP_PATH, Buffer.from(buffer));
    fs.chmodSync(YTDLP_PATH, '755'); // Dar permisos de ejecución en Linux
    
    console.log("✅ yt-dlp descargado e instalado con éxito.");
}

// Endpoint base: Mostrar la interfaz visual bonita
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ENDPOINT: Búsqueda de CUALQUIER VIDEO en YouTube
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Falta la búsqueda" });

        await ensureYtDlp();

        // Usar execFile es más seguro y evita errores con espacios o símbolos en la búsqueda
        execFile(YTDLP_PATH, [`ytsearch20:${query}`, '--dump-json', '--flat-playlist'], { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            // A veces yt-dlp manda advertencias por stderr, pero stdout sí tiene los datos
            if (error && !stdout) {
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
        console.error(error);
        res.status(500).json({ error: "Error inicializando entorno temporal." });
    }
});

// ENDPOINT: Obtener URL del Audio
app.get('/api/audio', async (req, res) => {
    try {
        const videoId = req.query.v;
        if (!videoId) return res.status(400).json({ error: "Falta el ID del video" });

        await ensureYtDlp();

        // Extraer la URL del mejor audio disponible
        execFile(YTDLP_PATH, ['-f', 'bestaudio/best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`], (error, stdout, stderr) => {
            if (error) {
                console.error("Error obteniendo audio:", stderr);
                return res.status(500).json({ error: "No se pudo extraer el audio" });
            }
            res.json({ url: stdout.trim() });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error inicializando entorno temporal." });
    }
});

// Exportar la app para que Vercel la ejecute
module.exports = app;