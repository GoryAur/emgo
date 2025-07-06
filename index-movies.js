require('dotenv').config()
const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const chokidar = require('chokidar');

// === CONFIGURACIÓN PERSONAL ===
const API_TOKEN = process.env.RD_API_KEY;
const WATCH_FOLDER = '/home/torrents/movies';
const RECHAZADOS_FOLDER = '/home/torrents/rechazados';
const RETRASO_ENTRE_ARCHIVOS_MS = 5000; // 5 segundos entre archivos
const MAX_REINTENTOS = 3;


// Asegurar que la carpeta exista
if (!fs.existsSync(RECHAZADOS_FOLDER)) {
  fs.mkdirSync(RECHAZADOS_FOLDER, { recursive: true });
}


const headers = {
  Authorization: `Bearer ${API_TOKEN}`
};

async function seleccionarArchivos(torrentId) {
  try {
    const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers });
    const extensionesValidas = ['.mp4', '.mkv', '.avi', '.mov', '.wmv'];
    const TAMANO_MIN_MB = 700; // solo archivos mayores a 700 MB

    const archivosValidos = info.data.files.filter(file => {
      const ext = path.extname(file.path).toLowerCase();
      const tamanoMB = file.bytes / 1024 / 1024;
      return extensionesValidas.includes(ext) && tamanoMB >= TAMANO_MIN_MB;
    });

    if (archivosValidos.length === 0) {
      console.log('⚠️ No se encontraron archivos de video válidos.');
      return;
    }

    const fileIds = archivosValidos.map(f => f.id).join(',');
    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, `files=${fileIds}`, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log(`✅ Archivos de video seleccionados (${archivosValidos.length}):`);
    archivosValidos.forEach(file => {
      const mb = (file.bytes / 1024 / 1024).toFixed(2);
      console.log(`  - ${file.path} (${mb} MB)`);
    });

  } catch (err) {
    console.error(`❌ Error al seleccionar archivos: ${err.response?.data?.error || err.message}`);
  }
}


async function subirMagnet(magnetLink, filepath) {
  try {
    const res = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', `magnet=${encodeURIComponent(magnetLink)}`, {
      headers,
      maxBodyLength: Infinity
    });
    console.log(`✅ Magnet subido: ${magnetLink}`);
    await seleccionarArchivos(res.data.id);

    // Borrar archivo después de procesar
    fs.unlinkSync(filepath);
    console.log(`🧹 Archivo eliminado: ${path.basename(filepath)}`);

  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    if (msg === 'infringing_file') {
      console.warn(`⚠️ Enlace bloqueado por Real-Debrid (infringing_file), moviendo archivo...`);
      const destino = path.join(RECHAZADOS_FOLDER, path.basename(filepath));
      await fse.move(filepath, destino, { overwrite: true });
      console.log(`🗂️ Archivo movido a: ${destino}`);
    } else {
      console.error(`❌ Error al subir magnet: ${msg}`);
    }
  }
}



async function subirTorrent(filepath) {
  try {
    const data = new FormData();
    data.append('file', fs.createReadStream(filepath));
    const res = await axios.put('https://api.real-debrid.com/rest/1.0/torrents/addTorrent', data, {
      headers: {
        ...headers,
        ...data.getHeaders()
      },
      maxBodyLength: Infinity
    });
    console.log(`✅ Archivo .torrent subido: ${path.basename(filepath)}`);
    await seleccionarArchivos(res.data.id);

    // Borrar archivo después de procesar
    fs.unlinkSync(filepath);
    console.log(`🧹 Archivo eliminado: ${path.basename(filepath)}`);

  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    if (msg === 'infringing_file') {
      console.warn(`⚠️ Archivo bloqueado por Real-Debrid (infringing_file), moviendo archivo...`);
      const destino = path.join(RECHAZADOS_FOLDER, path.basename(filepath));
      await fse.move(filepath, destino, { overwrite: true });
      console.log(`🗂️ Archivo movido a: ${destino}`);
    } else {
      console.error(`❌ Error al subir archivo: ${msg}`);
    }
  }
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, maxIntentos = MAX_REINTENTOS) {
  for (let i = 1; i <= maxIntentos; i++) {
    try {
      return await fn();
    } catch (err) {
      const esTemporal =
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'EAI_AGAIN' ||
        (err.response && err.response.status >= 500);

      if (!esTemporal || i === maxIntentos) {
        throw err;
      }

      const espera = i * 2000;
      console.warn(`⚠️ Reintento ${i}/${maxIntentos} tras ${espera}ms...`);
      await sleep(espera);
    }
  }
}


// Monitorear carpeta
console.log(`🚀 Monitoreando carpeta: ${WATCH_FOLDER}`);
const colaArchivos = [];
let procesando = false;

async function procesarCola() {
  if (procesando || colaArchivos.length === 0) return;
  procesando = true;

  while (colaArchivos.length > 0) {
    const { ext, filepath } = colaArchivos.shift();
    console.log(`🚧 Procesando: ${filepath}`);

    try {
      if (ext === '.torrent') {
        await withRetry(() => subirTorrent(filepath));
      } else {
        const content = fs.readFileSync(filepath, 'utf-8').trim();
        if (content.startsWith('magnet:?')) {
          await withRetry(() => subirMagnet(content, filepath));
        } else {
          console.warn(`⚠️ El archivo no contiene un magnet válido: ${filepath}`);
        }
      }
    } catch (err) {
      console.error(`❌ Falló después de reintentos: ${err.message}`);
    }

    await sleep(RETRASO_ENTRE_ARCHIVOS_MS);
  }

  procesando = false;
}

chokidar.watch(WATCH_FOLDER, {
  ignored: /^\./,
  persistent: true
}).on('add', filepath => {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.torrent' || ext === '.magnet' || ext === '.txt') {
    colaArchivos.push({ ext, filepath });
    procesarCola();
  }
});
