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
  .option('--clear-cache', 'Borrar caché antes de empezar')
  .parse(process.argv);

const options = program.opts();
const TMDB_API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_API_KEY2;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;
const CACHE_FILE = '.tmdb-movie-cache.json';
const SYMLINK_FILE = '.symlinked-movies.json';

const videoExtensions = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;

const qualityKeywords = ['2160p', '1080p', '720p', '480p', 'HDR', '4K'];
const sourceKeywords = ['WEB-DL', 'WEBRip', 'HDTV', 'BluRay', 'BDRemux', 'Remux', 'DVDRip'];
const videoCodecKeywords = ['x264', 'x265', 'H\\.264', 'H\\.265', 'AVC', 'HEVC', 'VP9'];
const audioCodecKeywords = ['AAC', 'AC3', 'DTS', 'DTS-HD', 'TrueHD', 'Atmos', 'DDP', 'FLAC'];
const editionKeywords = ['extended edition', 'directors cut', 'remastered', 'uncut', '3D', 'hsbs', 'Half-SBS', 'SBS'];

// Construye regex para detectar keywords
function buildKeywordRegex(list) {
  return new RegExp(`\\b(${list.join('|')})\\b`, 'gi');
}

const allKeywordsRegex = buildKeywordRegex([
  ...qualityKeywords,
  ...sourceKeywords,
  ...videoCodecKeywords,
  ...audioCodecKeywords,
  ...editionKeywords
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY + Math.floor(Math.random() * 2000));

function cleanTitle(str) {
  let result = str;
  for (const rx of cleaningRegexes) result = result.replace(rx, ' ');
  return result.trim();
}

// Limpia y parsea nombre archivo o carpeta
function parseFileName(filename) {
  let name = path.parse(filename).name;

  // Quitar prefijos típicos como "www.UIndex.org - "
  name = name.replace(/^\s*www\.[^-\s]+\s*-\s*/i, '');

  // Reemplaza puntos y guiones bajos por espacios
  let cleaned = name.replace(/[\._]/g, ' ').trim();

  // Detectar año
  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

  // Extraer título crudo (antes del año si existe)
  let rawTitle = cleaned;
  if (year) {
    rawTitle = cleaned.split(year)[0].trim();
  }

  // Eliminar etiquetas que confunden a TMDb/OMDb
  const stripLabels = [
  'unrated edition', 'extended edition', 'directors cut', 'remastered',
  'final cut', 'imax edition', 'ultimate edition', 'collector s edition',
  'limited', 'repack', 'readnfo', 'read note', 'edition', 'cut',
  '3d', 'hsbs', 'half sbs', 'proper', 'internal', 'cam', 'tc', 'ts',
  'hdtv', 'bluray', 'webrip', 'web-dl', 'dvdrip', 'xvid', 'x264', 'x265', 'hevc',
  'hdrip', 'collective', 'yify', 'evo', 'tgx', 'fgt', '1080p'
 ];


  const labelRegex = new RegExp(`\\b(${stripLabels.join('|')})\\b`, 'gi');
  rawTitle = rawTitle.replace(labelRegex, '').replace(/\s{2,}/g, ' ').trim();

  const descriptors = cleaned.match(allKeywordsRegex);
  const uniqueDescriptors = descriptors
    ? [...new Set(descriptors.map(k => k.toUpperCase()))].join(' ')
    : '';

  return {
    rawTitle,
    year,
    descriptors: uniqueDescriptors.trim()
  };
}

async function loadJSON(file) {
  try { return await fs.readJSON(file); } catch { return {}; }
}

async function saveJSON(file, data) {
  try { await fs.writeJSON(file, data, { spaces: 2 }); } catch (e) { console.error(`❌ Error guardando ${file}:`, e.message); }
}

async function fetchMovie(query, year, tmdbCache) {
  const key = `${query.toLowerCase()}|${year || ''}`;
  if (tmdbCache[key]) return tmdbCache[key];

  try {
    const tmdbRes = await axios.get('https://api.themoviedb.org/3/search/movie', {
      params: { api_key: TMDB_API_KEY, query, language: LANGUAGE, year },
      headers: { 'User-Agent': 'EmbySymlink/1.0' }
    });
    if (tmdbRes.data.results.length) {
      const best = tmdbRes.data.results.find(r => r.release_date?.startsWith(String(year))) || tmdbRes.data.results[0];
      tmdbCache[key] = best;
      await saveJSON(CACHE_FILE, tmdbCache);
      return best;
    }
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn('⚠️ Rate limit alcanzado, esperando 10s...');
      await sleep(10000);
      return fetchMovie(query, year, tmdbCache);
    }
    console.warn(`❌ Error TMDb: ${query} - ${e.message}`);
  }

  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', {
      params: { apikey: OMDB_API_KEY, t: query, type: 'movie', y: year }
    });
    if (omdbRes.data?.Response === 'True') {
      const title = omdbRes.data.Title;
      return fetchMovie(title, year, tmdbCache);
    }
  } catch (e) {
    console.warn(`❌ Error OMDb: ${query} - ${e.message}`);
  }

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

async function createSymlink(filePath, tmdbCache, linkCache, destDir) {
  const fileName = path.basename(filePath);
  if (linkCache[fileName] && await fs.pathExists(linkCache[fileName])) return;

  const parsed = parseFileName(fileName);
  if (!parsed.rawTitle || parsed.rawTitle.length < 2) return;

  const { rawTitle, year, descriptors } = parsed;
  const movie = await fetchMovie(rawTitle, year, tmdbCache);
  if (!movie) {
    console.warn(`⚠️ No encontrado en TMDb/OMDb: ${rawTitle}`);
    return;
  }

  const movieTitle = movie.title || rawTitle;
  const movieYear = movie.release_date?.split('-')[0] || year || '0000';
  const folder = path.join(destDir, `${movieTitle} (${movieYear})`);
  const destFile = path.join(folder, `${movieTitle} (${movieYear})${descriptors ? ' - ' + descriptors : ''}${path.extname(filePath)}`);

  await fs.ensureDir(folder);
  if (await fs.pathExists(destFile)) return;

  if (DRY_RUN) console.log(`[Dry Run] ➤ ${destFile}`);
  else {
    try {
      await fs.symlink(filePath, destFile);
      console.log(`✅ Symlink creado: ${destFile}`);
      linkCache[fileName] = destFile;
      await saveJSON(SYMLINK_FILE, linkCache);
    } catch (e) {
      console.error(`❌ Error creando symlink: ${destFile} - ${e.message}`);
    }
  }

  await randomDelay();
}

(async () => {
  if (options.clearCache) await fs.remove(CACHE_FILE);
  const sourceDir = path.resolve(options.source);
  const destDir = path.resolve(options.dest);

  const files = await findVideoFiles(sourceDir);
  const tmdbCache = await loadJSON(CACHE_FILE);
  const linkCache = await loadJSON(SYMLINK_FILE);

  for (const filePath of files) {
    await createSymlink(filePath, tmdbCache, linkCache, destDir);
  }
})();
