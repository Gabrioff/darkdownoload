const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Aumentamos el límite para permitir recibir audio grabado
app.use(express.json({ limit: '20mb' })); 

// 7 Instancias públicas para burlar bloqueos (Carrera de servidores)
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

// SISTEMA "CARRERA DE SERVIDORES" (El primero que responda gana)
async function getFastestStream(videoId, isAudio) {
    const invPromises = INVIDIOUS_INSTANCES.map(instance => 
        new Promise(async (resolve, reject) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos máximo
                const res = await fetch(`${instance}/api/v1/videos/${videoId}`, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (res.ok) {
                    const data = await res.json();
                    if (isAudio && data.adaptiveFormats) {
                        const audios = data.adaptiveFormats.filter(f => f.type && f.type.includes('audio'));
                        if (audios.length > 0) return resolve(audios[0].url);
                    }
                    if (!isAudio && data.formatStreams) {
                        const videos = data.formatStreams.filter(f => f.resolution);
                        if (videos.length > 0) return resolve(videos[0].url);
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

    try {
        // Ejecuta todas las peticiones al mismo tiempo. La más rápida gana.
        return await Promise.any([...invPromises, ...pipedPromises]);
    } catch (error) {
        return null;
    }
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

        // Carrera también para las búsquedas
        const searchPromises = PIPED_INSTANCES.map(instance => 
            new Promise(async (resolve, reject) => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 4000);
                    const res = await fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=all`, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    
                    if (res.ok) {
                        const data = await res.json();
                        if (data.items && data.items.length > 0) {
                            const videos = data.items.filter(i => i.type === 'stream').map(i => ({
                                id: i.url.split('v=')[1] || i.url.split('/').pop(),
                                title: i.title,
                                author: i.uploaderName,
                                thumb: i.thumbnail,
                                duration: i.duration
                            }));
                            if (videos.length > 0) return resolve(videos);
                        }
                    }
                    reject();
                } catch(e) { reject(); }
            })
        );

        const results = await Promise.any(searchPromises);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: "Servidores de búsqueda ocupados." });
    }
});

// ENDPOINT: Extraer enlace de AUDIO
app.get('/api/audio', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    const url = await getFastestStream(videoId, true);
    if (url) res.json({ url });
    else res.status(500).json({ error: "Bloqueado por YouTube" });
});

// ENDPOINT: Extraer enlace de VIDEO
app.get('/api/video', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) return res.status(400).json({ error: "Falta ID" });

    const url = await getFastestStream(videoId, false);
    if (url) res.json({ url });
    else res.status(500).json({ error: "Bloqueado por YouTube" });
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