require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

program
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/movies/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/movies/')
  .option('--delay <ms>', 'Retraso base entre peticiones (ms)', '2000')
  .option('--dry-run', 'Simular sin crear symlinks')
  .option('--lang <code>', 'Idioma TMDb', 'en-US')
  .option('--clear-cache', 'Borrar caché de TMDb antes de empezar')
  .option('--fix-names', 'Busca y corrige nombres con ":" en el directorio destino y actualiza el caché de symlinks')
  .parse(process.argv);

const options = program.opts();
const TMDB_API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_API_KEY2;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;

const destDir = path.resolve(options.dest);
const CACHE_FILE = path.join(destDir, '.tmdb-movie-cache.json');
const SYMLINK_FILE = path.join(destDir, '.symlinked-movies.json');

const videoExtensions = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;

const qualityKeywords = ['2160p', '1080p', '720p', '480p', 'HDR', '4K'];
const sourceKeywords = ['WEB-DL', 'WEBRip', 'HDTV', 'BluRay', 'BDRemux', 'Remux', 'DVDRip'];
const videoCodecKeywords = ['x264', 'x265', 'H\\.264', 'H\\.265', 'AVC', 'HEVC', 'VP9'];
const audioCodecKeywords = ['AAC', 'AC3', 'DTS', 'DTS-HD', 'TrueHD', 'Atmos', 'DDP', 'FLAC'];
const editionKeywords = ['extended edition', 'directors cut', 'remastered', 'uncut', '3D', 'hsbs', 'Half-SBS', 'SBS'];

function buildKeywordRegex(list) { return new RegExp(`\\b(${list.join('|')})\\b`, 'gi'); }

const allKeywordsRegex = buildKeywordRegex([...qualityKeywords, ...sourceKeywords, ...videoCodecKeywords, ...audioCodecKeywords, ...editionKeywords]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY + Math.floor(Math.random() * 2000));

// --- FUNCIÓN 'parseFileName' MEJORADA ---
function parseFileName(filename) {
    let name = path.parse(filename).name;

    // 1. Limpieza inicial: Reemplaza puntos y guiones bajos por espacios.
    let cleaned = name.replace(/[\._]/g, ' ').trim();

    // 2. Limpieza previa: Normaliza patrones comunes ANTES de buscar el año.
    cleaned = cleaned
        // Eliminar prefijos de sitios web (ej. "www.UIndex.org - ")
        .replace(/^\s*www\.[^-\s]+\s*-\s*/i, '')
        // Estandarizar "Ep1", "ep 01", etc. a "Episode 1"
        .replace(/\bEp\s*(\d{1,2})\b/gi, 'Episode $1')
        // Eliminar guiones bajos o puntos repetidos que se convirtieron en multi-espacios
        .replace(/\s{2,}/g, ' ')
        .trim();
    
    // 3. Detectar el año de forma fiable.
    const yearMatch = cleaned.match(/\b(19[5-9]\d|20\d{2})\b/);
    const year = yearMatch ? yearMatch[0] : null;

    // 4. Extraer el título "crudo" cortando la cadena JUSTO ANTES del año.
    //    Esto es más preciso que usar .split(), que puede dejar caracteres basura.
    let rawTitle = cleaned;
    if (yearMatch) {
        rawTitle = cleaned.substring(0, yearMatch.index).trim();
    }

    // 5. Limpieza final sobre el título ya extraído.
    //    Esto elimina etiquetas de calidad, de escena y guiones sobrantes.
    const stripLabels = [
        'unrated', 'extended', 'directors cut', 'remastered', 'final cut', 'uncut',
        'imax', 'ultimate', 'collectors', 'limited', 'repack', 'readnfo',
        'proper', 'internal', 'cam', 'tc', 'ts', '3d', 'hsbs', 'sbs',
        'hdtv', 'bluray', 'webrip', 'web dl', 'dvdrip', 'hdrip',
        'xvid', 'x264', 'x265', 'hevc', 'avc', 'h264', 'h265',
        'aac', 'ac3', 'dts', 'truehd', 'atmos', 'ddp',
        'yify', 'evo', 'fgt', 'tgx'
    ];
    const labelRegex = new RegExp(`\\b(${stripLabels.join('|')})\\b`, 'gi');
    rawTitle = rawTitle
        .replace(labelRegex, '') // Elimina todas las etiquetas de la lista
        .replace(/-\s*$/, '')    // Elimina un guion flotante al final (ej. "Star Wars - ")
        .replace(/\s{2,}/g, ' ') // Limpia múltiples espacios de nuevo
        .trim();

    // Extraer descriptores (calidad, etc.) del nombre de archivo original.
    const descriptors = name.match(allKeywordsRegex);
    const uniqueDescriptors = descriptors
        ? [...new Set(descriptors.map(k => k.toUpperCase()))].join(' ')
        : '';
    
    return {
        rawTitle,
        year,
        descriptors: uniqueDescriptors.trim()
    };
}


async function loadJSON(file) { try { return await fs.readJSON(file); } catch { return {}; } }
async function saveJSON(file, data) { try { await fs.writeJSON(file, data, { spaces: 2 }); } catch (e) { console.error(`❌ Error guardando ${file}:`, e.message); } }

async function fetchMovie(query, year, tmdbCache) {
  const key = `${query.toLowerCase()}|${year || ''}`;
  if (tmdbCache[key]) return tmdbCache[key];
  try {
    const tmdbRes = await axios.get('https://api.themoviedb.org/3/search/movie', { params: { api_key: TMDB_API_KEY, query, language: LANGUAGE, year }, headers: { 'User-Agent': 'EmbySymlink/1.0' } });
    if (tmdbRes.data.results.length) {
      const best = tmdbRes.data.results.find(r => r.release_date?.startsWith(String(year))) || tmdbRes.data.results[0];
      tmdbCache[key] = best; await saveJSON(CACHE_FILE, tmdbCache); return best;
    }
  } catch (e) {
    if (e.response?.status === 429) { console.warn('⚠️ Rate limit alcanzado, esperando 10s...'); await sleep(10000); return fetchMovie(query, year, tmdbCache); }
    console.warn(`❌ Error TMDb: ${query} - ${e.message}`);
  }
  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', { params: { apikey: OMDB_API_KEY, t: query, type: 'movie', y: year } });
    if (omdbRes.data?.Response === 'True') { const title = omdbRes.data.Title; return fetchMovie(title, year, tmdbCache); }
  } catch (e) { console.warn(`❌ Error OMDb: ${query} - ${e.message}`); }
  return null;
}

async function findVideoFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findVideoFiles(fullPath));
    else if (entry.isFile() && videoExtensions.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function createSymlink(filePath, tmdbCache, linkCache) {
  const fileName = path.basename(filePath);
  if (linkCache[fileName] && await fs.pathExists(linkCache[fileName])) {
      console.log(`❕ Symlink para ${fileName} ya existe en ${linkCache[fileName]}. Saltando.`);
      return;
  }

  const parsed = parseFileName(fileName);
  if (!parsed.rawTitle || parsed.rawTitle.length < 2) {
      console.log(`❕ Título demasiado corto o inválido para ${fileName} después de limpiar. Saltando.`);
      return;
  }

  console.log(`\n🔎 Procesando: ${fileName}`);
  const { rawTitle, year, descriptors } = parsed;
  const movie = await fetchMovie(rawTitle, year, tmdbCache);
  if (!movie) { console.warn(`⚠️ No encontrado en TMDb/OMDb: ${rawTitle}`); return; }

  const movieTitle = (movie.title || rawTitle).replace(/:/g, ' -').replace(/\//g, '-');
  const movieYear = movie.release_date?.split('-')[0] || year || '0000';
  const folder = path.join(destDir, `${movieTitle} (${movieYear})`);
  const destFile = path.join(folder, `${movieTitle} (${movieYear})${descriptors ? ' - ' + descriptors : ''}${path.extname(filePath)}`);

  await fs.ensureDir(folder);
  if (await fs.pathExists(destFile)) { console.log(`❕ El archivo destino ya existe: ${destFile}. Saltando.`); return; }

  if (DRY_RUN) console.log(`[Dry Run] ➤ ${filePath} → ${destFile}`);
  else {
    try {
      await fs.symlink(filePath, destFile);
      console.log(`✅ Symlink creado: ${destFile}`);
      linkCache[fileName] = destFile;
      await saveJSON(SYMLINK_FILE, linkCache);
    } catch (e) { console.error(`❌ Error creando symlink: ${destFile} - ${e.message}`); }
  }
  await randomDelay();
}

async function fixNames(targetDir) {
  console.log(`🔍 Escaneando recursivamente para corregir nombres en: ${targetDir}\n`);
  const linkCache = await loadJSON(SYMLINK_FILE);
  const originalCacheState = JSON.stringify(linkCache);

  async function walkAndFix(currentDir) {
    let items;
    try { items = await fs.readdir(currentDir, { withFileTypes: true }); } 
    catch (err) { console.warn(`  ❌ No se pudo leer el directorio ${currentDir}: ${err.message}`); return; }

    for (const item of items) {
      if (item.name === path.basename(SYMLINK_FILE) || item.name === path.basename(CACHE_FILE)) continue;
      const oldPath = path.join(currentDir, item.name);
      let pathForRecursion = oldPath;
      if (item.name.includes(':')) {
        const newName = item.name.replace(/: /g, ' - ').replace(/:/g, ' -');
        const newPath = path.join(currentDir, newName);
        console.log(`🔁 Detectado con ':' → ${oldPath}`);
        if (await fs.pathExists(newPath)) { console.log(`  ⚠️  No se puede renombrar, ya existe: ${newName}`); } 
        else {
          try {
            await fs.rename(oldPath, newPath);
            console.log(`  ✅ Renombrado → ${newName}\n`);
            pathForRecursion = newPath;
            for (const [key, targetPath] of Object.entries(linkCache)) {
              if (targetPath.startsWith(oldPath)) {
                const updatedPath = targetPath.replace(oldPath, newPath);
                linkCache[key] = updatedPath;
                console.log(`  🔄 Cache de symlink actualizado: '${key}' ahora apunta a '${updatedPath}'`);
              }
            }
          } catch (err) { console.warn(`  ❌ Error al renombrar ${item.name}: ${err.message}`); continue; }
        }
      }
      if (item.isDirectory()) { await walkAndFix(pathForRecursion); }
    }
  }

  await walkAndFix(targetDir);
  if (JSON.stringify(linkCache) !== originalCacheState) {
    await saveJSON(SYMLINK_FILE, linkCache);
    console.log(`💾 Caché de symlinks (${path.basename(SYMLINK_FILE)}) actualizado con nuevos nombres.`);
  }
  console.log(`✅ Proceso de corrección completado.\n`);
}

(async () => {
  if (options.fixNames) { await fixNames(destDir); return; }
  if (options.clearCache) { console.log('🗑️  Borrando caché de TMDb...'); await fs.remove(CACHE_FILE); }
  const sourceDir = path.resolve(options.source);
  console.log(`🎬 Empezando a escanear ${sourceDir}...`);
  const files = await findVideoFiles(sourceDir);
  const tmdbCache = await loadJSON(CACHE_FILE);
  const linkCache = await loadJSON(SYMLINK_FILE);
  console.log(`Found ${files.length} video files. Analizando y creando symlinks...`);
  for (const filePath of files) { await createSymlink(filePath, tmdbCache, linkCache); }
  console.log('\n🏁 Proceso finalizado.');
})();
