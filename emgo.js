#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

program
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/movies/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/movies/')
  .option('--delay <ms>', 'Retraso entre peticiones a TMDb (ms)', '1000')
  .option('--dry-run', 'Simular sin crear symlinks')
  .option('--lang <code>', 'Idioma para títulos TMDb', 'en-US')
  .option('--clear-cache', 'Borrar la caché de archivos procesados antes de empezar')
  .parse(process.argv);

const options = program.opts();

const TMDB_API_KEY = 'b5d995898d8bc29c0fc93c9de4865b81';
const OMDB_API_KEY = 'fa157d83';  // Tu clave OMDb
const LANGUAGE = options.lang;
const DELAY_BETWEEN_REQUESTS_MS = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;

const CACHE_FILE = path.resolve('.symlinked.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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


async function fetchMovieWithFallback(query, year = null) {
  const tmdbParams = {
    api_key: TMDB_API_KEY,
    query,
    language: LANGUAGE
  };
  if (year) tmdbParams.year = year;

  // 1. Buscar en TMDb
  try {
    const tmdbRes = await axios.get('https://api.themoviedb.org/3/search/movie', { params: tmdbParams });
    if (tmdbRes.data.results.length > 0) {
      return tmdbRes.data.results[0];
    }
  } catch (err) {
    console.warn(`❌ TMDb error con "${query}":`, err.message);
  }

  // 2. Buscar en OMDb
  console.log(`🔄 Buscando en OMDb: "${query}"...`);
  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', {
      params: {
        t: query,
        y: year || '',
        apikey: OMDB_API_KEY
      }
    });

    if (omdbRes.data && omdbRes.data.Response === 'True') {
      const omdbTitle = omdbRes.data.Title;
      const omdbYear = omdbRes.data.Year;
      console.log(`✅ OMDb encontró: "${omdbTitle}" (${omdbYear})`);

      // Reintentar en TMDb con datos OMDb
      const retryParams = {
        api_key: TMDB_API_KEY,
        query: omdbTitle,
        language: LANGUAGE
      };
      if (omdbYear) retryParams.year = omdbYear;

      const retryRes = await axios.get('https://api.themoviedb.org/3/search/movie', { params: retryParams });
      if (retryRes.data.results.length > 0) {
        return retryRes.data.results[0];
      } else {
        console.warn(`⚠️ TMDb aún no encontró: "${omdbTitle}" (${omdbYear})`);
      }
    } else {
      console.warn(`❌ OMDb no encontró: "${query}"`);
    }
  } catch (err) {
    console.error(`❌ Error consultando OMDb para "${query}":`, err.message);
  }

  return null;
}

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ Error guardando caché:', err.message);
  }
}

async function clearCache() {
  try {
    await fs.unlink(CACHE_FILE);
    console.log('🗑️ Caché borrada.');
  } catch {
    console.log('🗑️ Caché no existe o ya fue borrada.');
  }
}

async function findVideoFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findVideoFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && videoExtensions.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function createSymlink(fullFilePath, movieDataCache, sourceDir, destDir, cache) {
  const fileName = path.basename(fullFilePath);

  if (cache[fileName]) {
    const symlinkPath = cache[fileName];
    const exists = await fs.pathExists(symlinkPath);
    if (exists) {
      console.log(`⏭ [Cache] Ya existe symlink para "${fileName}" en "${symlinkPath}"`);
      return;
    } else {
      console.log(`⚠️ [Cache] Symlink faltante para "${fileName}", se recreará.`);
    }
  }

  const parsed = parseFileName(fileName);
  if (!parsed) {
    console.warn(`⚠️ No se pudo parsear: ${fileName}`);
    return;
  }

  const { rawTitle, year, descriptors } = parsed;
  const cacheKey = `${rawTitle.toLowerCase()}-${year || 'any'}`;

  let movie = movieDataCache[cacheKey];
  if (!movie) {
    movie = await fetchMovieWithFallback(rawTitle, year);
    if (!movie && !year) {
      movie = await fetchMovieWithFallback(rawTitle);
    }

    if (!movie) {
      console.warn(`⚠️ No se encontró en TMDb/OMDb: ${rawTitle}`);
      return;
    }

    movieDataCache[cacheKey] = movie;
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  const title = movie.title || rawTitle;
  const tmdbYear = movie.release_date?.split('-')[0] || year || '0000';
  const extension = path.extname(fileName);
  const sourcePath = fullFilePath;

  const baseName = descriptors
    ? `${title} (${tmdbYear}) - ${descriptors}${extension}`
    : `${title} (${tmdbYear})${extension}`;

  const folderPath = path.join(destDir, `${title} (${tmdbYear})`);
  const destPath = path.join(folderPath, baseName);

  if (DRY_RUN) {
    console.log(`[Dry Run] ➤ ${destPath}`);
    return;
  }

  try {
    await fs.ensureDir(folderPath);
    await fs.symlink(sourcePath, destPath);
    console.log(`✅ Symlink creado: ${destPath}`);

    cache[fileName] = destPath;
    await saveCache(cache);
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(`⏭ Ya existe: ${destPath}`);

      cache[fileName] = destPath;
      await saveCache(cache);
    } else {
      console.error(`❌ Error creando symlink para ${fileName}`, err.message);
    }
  }
}

async function main() {
  if (options.clearCache) {
    await clearCache();
  }

  const sourceDir = path.resolve(options.source);
  const destDir = path.resolve(options.dest);

  const videoFiles = await findVideoFiles(sourceDir);

  const movieDataCache = {};
  const cache = await loadCache();

  for (const filePath of videoFiles) {
    await createSymlink(filePath, movieDataCache, sourceDir, destDir, cache);
  }
}

main();
