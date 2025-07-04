#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

program
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/shows/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/tvshows/')
  .option('--delay <ms>', 'Retraso entre peticiones (ms)', '1000')
  .option('--dry-run', 'Simular sin crear symlinks')
  .option('--lang <code>', 'Idioma para TMDb', 'en-US')
  .option('--clear-cache', 'Borrar la caché antes de empezar')
  .parse(process.argv);

const options = program.opts();

const TMDB_API_KEY = 'b5d995898d8bc29c0fc93c9de4865b81';
const OMDB_API_KEY = 'fa157d83';
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;
const CACHE_FILE = '.symlinked-series.json';

const videoExtensions = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;
const seasonEpisodeRegex = /S(\d{1,2})E(\d{1,2})/i;
const allKeywordsRegex = /\b(2160p|1080p|720p|WEB[- ]?DL|WEBRIP|HDR|BLURAY|REMUX|HDTV|X264|X265|AAC|AC3|DTS|FLAC|HEVC|10bit|H\.?(264|265)|DDP|ATMOS)\b/gi;

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function parseFileName(filename) {
  const name = path.parse(filename).name.replace(/[\._]/g, ' ');
  const seMatch = name.match(seasonEpisodeRegex);
  if (!seMatch) return null;

  const season = String(parseInt(seMatch[1])).padStart(2, '0');
  const episode = String(parseInt(seMatch[2])).padStart(2, '0');

  let titleBeforeSE = name.split(seMatch[0])[0];
  titleBeforeSE = titleBeforeSE
    .replace(/\(\d{4}\)/, '')
    .replace(/[-–—\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const descriptors = name.match(allKeywordsRegex);
  const uniqueDescriptors = descriptors ? [...new Set(descriptors.map(d => d.toUpperCase()))].join(' ') : '';

  return {
    rawTitle: titleBeforeSE.trim(),
    season,
    episode,
    descriptors: uniqueDescriptors
  };
}

async function fetchSeriesFromTMDB(query) {
  try {
    const res = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query, language: LANGUAGE }
    });
    if (res.data.results.length > 0) {
      return res.data.results[0];
    }
  } catch (e) {
    console.warn(`❌ Error TMDb: ${query}`, e.message);
  }
  return null;
}

async function fetchSeriesWithFallback(query) {
  let show = await fetchSeriesFromTMDB(query);
  if (show) return show;

  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', {
      params: { t: query, type: 'series', apikey: OMDB_API_KEY }
    });
    if (omdbRes.data && omdbRes.data.Response === 'True') {
      const cleanTitle = omdbRes.data.Title;
      show = await fetchSeriesFromTMDB(cleanTitle);
      return show;
    }
  } catch (e) {
    console.warn(`❌ Error OMDb: ${query}`, e.message);
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
  } catch (e) {
    console.error('❌ Error guardando caché', e.message);
  }
}

async function clearCache() {
  try {
    await fs.unlink(CACHE_FILE);
    console.log('🗑️ Caché borrada.');
  } catch {}
}

async function createSymlink(filePath, tmdbCache, symlinkCache, destDir) {
  const fileName = path.basename(filePath);
  if (symlinkCache[fileName]) {
    const dest = symlinkCache[fileName];
    const exists = await fs.pathExists(dest);
    if (exists) {
      console.log(`⏭ [Cache] ${fileName}`);
      return;
    }
  }

  let parsed = parseFileName(fileName);

  if (!parsed || !parsed.rawTitle) {
    // fallback: usar carpeta padre
    const parentFolder = path.basename(path.dirname(filePath));
    const cleanedFolderTitle = parentFolder
      .replace(/\(\d{4}\)/, '')
      .replace(/[-_]/g, ' ')
      .replace(/S\d{1,2}$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const seMatch = fileName.match(seasonEpisodeRegex);
    if (seMatch) {
      parsed = {
        rawTitle: cleanedFolderTitle,
        season: String(parseInt(seMatch[1])).padStart(2, '0'),
        episode: String(parseInt(seMatch[2])).padStart(2, '0'),
        descriptors: ''
      };
      console.warn(`📂 Usando nombre de carpeta como título: ${parsed.rawTitle}`);
    } else {
      console.warn(`⚠️ No se pudo extraer título de: ${fileName}`);
      return;
    }
  }

  const { rawTitle, season, episode, descriptors } = parsed;
  const cacheKey = rawTitle.toLowerCase();
  let show = tmdbCache[cacheKey];

  if (!show) {
    show = await fetchSeriesWithFallback(rawTitle);
    if (!show) {
      console.warn(`⚠️ No encontrado en TMDb/OMDb: ${rawTitle}`);
      return;
    }
    tmdbCache[cacheKey] = show;
    await sleep(DELAY);
  }

  const year = show.first_air_date?.split('-')[0] || '0000';
  const showTitle = show.name || rawTitle;
  const ext = path.extname(fileName);
  const baseName = `${showTitle} S${season}E${episode}${descriptors ? ` - ${descriptors}` : ''}${ext}`;
  const folder = path.join(destDir, `${showTitle} (${year})`, `Season ${parseInt(season)}`);
  const destPath = path.join(folder, baseName);

  if (DRY_RUN) {
    console.log(`[Dry Run] ➤ ${destPath}`);
    return;
  }

  try {
    await fs.ensureDir(folder);
    await fs.symlink(filePath, destPath);
    console.log(`✅ Symlink: ${destPath}`);
    symlinkCache[fileName] = destPath;
    await saveCache(symlinkCache);
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.log(`⏭ Ya existe: ${destPath}`);
    } else {
      console.error(`❌ Error creando symlink: ${fileName}`, e.message);
    }
  }
}

async function main() {
  if (options.clearCache) {
    await clearCache();
  }

  const sourceDir = path.resolve(options.source);
  const destDir = path.resolve(options.dest);

  const files = await findVideoFiles(sourceDir);
  const tmdbCache = {};
  const symlinkCache = await loadCache();

  for (const filePath of files) {
    await createSymlink(filePath, tmdbCache, symlinkCache, destDir);
  }
}

main();
