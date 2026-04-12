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

// INSTALADOR
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

// APIs DE RESPALDO (Carrera)
const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.smnz.de",
    "https://api.piped.projectsegfau.lt"
];

async function getFastestStream(videoId, isAudio) {
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
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// DESCARGA DE AUDIO (Redirección Automática)
app.get('/api/download-audio', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).send("Falta ID");

    try {
        await ensureYtDlp();
        const stdout = await runYtDlp(['-f', 'bestaudio', '--get-url', `https://www.youtube.com/watch?v=${videoId}`]);
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) return res.redirect(302, url);
        throw new Error("URL inválida");
    } catch (error) {
        const fallbackUrl = await getFastestStream(videoId, true);
        if (fallbackUrl) return res.redirect(302, fallbackUrl);
        res.status(500).send("YouTube bloqueó temporalmente la descarga. Intenta de nuevo más tarde.");
    }
});

// DESCARGA DE VIDEO (Redirección Automática)
app.get('/api/download-video', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).send("Falta ID");

    try {
        await ensureYtDlp();
        const stdout = await runYtDlp(['-f', 'best', '--get-url', `https://www.youtube.com/watch?v=${videoId}`]);
        const url = stdout.trim().split('\n')[0];
        if (url && url.startsWith('http')) return res.redirect(302, url);
        throw new Error("URL inválida");
    } catch (error) {
        const fallbackUrl = await getFastestStream(videoId, false);
        if (fallbackUrl) return res.redirect(302, fallbackUrl);
        res.status(500).send("YouTube bloqueó temporalmente la descarga. Intenta de nuevo más tarde.");
    }
});

// SHAZAM
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