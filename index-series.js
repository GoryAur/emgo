
require('dotenv').config()
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chokidar = require('chokidar');

const API_TOKEN = process.env.RD_API_KEY; // 👈 Reemplaza por tu token Real-Debrid
const WATCH_FOLDER = '/home/torrents/series';
const RETRASO_ENTRE_ARCHIVOS_MS = 5000;
const MAX_REINTENTOS = 3;
const headers = { Authorization: `Bearer ${API_TOKEN}` };

if (!fs.existsSync(`${WATCH_FOLDER}/rechazados`)) {
  fs.mkdirSync(`${WATCH_FOLDER}/rechazados`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, maxIntentos = MAX_REINTENTOS) {
  for (let i = 1; i <= maxIntentos; i++) {
    try {
      return await fn();
    } catch (err) {
      const temporal = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
        err.code === 'EAI_AGAIN' || (err.response && err.response.status >= 500);

      if (!temporal || i === maxIntentos) throw err;

      const espera = i * 2000;
      console.warn(`⚠️ Reintento ${i}/${maxIntentos} en ${espera}ms...`);
      await sleep(espera);
    }
  }
}

async function seleccionarArchivos(torrentId) {
  try {
    const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
    const extensionesValidas = ['.mp4', '.mkv', '.avi', '.mov', '.wmv'];
    const TAMANO_MIN_MB = 50;

    const regexEpisodio = /S(\d{2})E(\d{2})|(\d{1,2})x(\d{2})/i;

    const palabrasProhibidas = [
      'extra', 'special', 'featurette', 'trailer',
      'behind', 'interview', 'recap', 'feature',
      'making', 'inside'
    ];

    const archivosValidos = [];

    for (const file of info.data.files) {
      const ext = path.extname(file.path).toLowerCase();
      const tamanoMB = file.bytes / 1024 / 1024;
      const nombre = path.basename(file.path).toLowerCase();

      if (!extensionesValidas.includes(ext)) {
        console.log(`❌ Extensión inválida: ${file.path}`);
        continue;
      }

      if (tamanoMB < TAMANO_MIN_MB) {
        console.log(`❌ Muy pequeño: ${file.path}`);
        continue;
      }

      const match = nombre.match(regexEpisodio);
      if (!match) {
        console.log(`❌ Sin patrón de episodio válido: ${file.path}`);
        continue;
      }

      const season = parseInt(match[1] || match[3], 10);
      const episode = parseInt(match[2] || match[4], 10);
      if (season < 1 || episode < 1) {
        console.log(`❌ S${season}E${episode} inválido: ${file.path}`);
        continue;
      }

      if (palabrasProhibidas.some(p => nombre.includes(p))) {
        console.log(`❌ Contiene palabra prohibida: ${file.path}`);
        continue;
      }

      archivosValidos.push(file);
    }

    if (archivosValidos.length === 0) {
      console.log('⚠️ No se encontraron episodios válidos.');
      return;
    }

    const fileIds = archivosValidos.map(f => f.id).join(',');
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, `files=${fileIds}`, {
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log(`✅ Episodios seleccionados (${archivosValidos.length}):`);
    archivosValidos.forEach(f => {
      console.log(`  - ${f.path} (${(f.bytes / 1024 / 1024).toFixed(2)} MB)`);
    });

  } catch (err) {
    console.error(`❌ Error seleccionando archivos: ${err.response?.data?.error || err.message}`);
  }
}

async function subirTorrent(filepath) {
  const data = new FormData();
  data.append('file', fs.createReadStream(filepath));

  const res = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addTorrent', data, {
    headers: { ...headers, ...data.getHeaders() }
  });

  const id = res.data.id;
  console.log(`📦 Subido torrent: ${filepath}`);
  await seleccionarArchivos(id);
  fs.unlinkSync(filepath);
}

async function subirMagnet(magnet, filepath) {
  try {
    const res = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', `magnet=${encodeURIComponent(magnet)}`, {
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const id = res.data.id;
    console.log(`📦 Subido magnet: ${path.basename(filepath)}`);
    await seleccionarArchivos(id);
    fs.unlinkSync(filepath);

  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error(`❌ Error al subir magnet: ${errorMsg}`);
    if (errorMsg === 'infringing_file') {
      const destino = path.join(WATCH_FOLDER, 'rechazados', path.basename(filepath));
      fs.renameSync(filepath, destino);
      console.log(`📥 Movido a rechazados: ${destino}`);
    }
  }
}

const cola = [];
let procesando = false;

async function procesarCola() {
  if (procesando || cola.length === 0) return;
  procesando = true;

  while (cola.length > 0) {
    const { ext, filepath } = cola.shift();
    console.log(`🚧 Procesando: ${filepath}`);

    try {
      if (ext === '.torrent') {
        await withRetry(() => subirTorrent(filepath));
      } else {
        const contenido = fs.readFileSync(filepath, 'utf-8').trim();
        if (contenido.startsWith('magnet:?')) {
          await withRetry(() => subirMagnet(contenido, filepath));
        } else {
          console.warn(`⚠️ Archivo no contiene magnet válido: ${filepath}`);
        }
      }
    } catch (err) {
      console.error(`❌ Falló tras reintentos: ${err.message}`);
    }

    await sleep(RETRASO_ENTRE_ARCHIVOS_MS);
  }

  procesando = false;
}

console.log(`🚀 Monitoreando carpeta: ${WATCH_FOLDER}`);
chokidar.watch(WATCH_FOLDER, {
  ignored: /(^|[\/\\])\../,
  persistent: true
}).on('add', filepath => {
  const ext = path.extname(filepath).toLowerCase();
  if (['.torrent', '.magnet', '.txt'].includes(ext)) {
    cola.push({ ext, filepath });
    procesarCola();
  }
});
