require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

program
  .option('--fix-names', 'Renombrar symlinks/carpetas con ":" al estilo Radarr')
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/shows/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/tvshows/')
  .option('--delay <ms>', 'Retraso base entre peticiones (ms)', '2000')
  .option('--dry-run', 'Simular sin crear symlinks')
  .option('--lang <code>', 'Idioma TMDb', 'en-US')
  .option('--clear-cache', 'Borrar caché antes de empezar')
  .parse(process.argv);

const options = program.opts();
const TMDB_API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_API_KEY2;
const OMDB_API_KEY = process.env.TMDB_API_KEY || process.env.OMDB_API_KEY2;
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;
const CACHE_FILE = '.symlinked-series.json';

const videoExtensions = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;
const seasonEpisodeRegex = /S(\d{1,2})E(\d{2})(?:[-]?E?(\d{2}))?|(\\d{1,2})x(\\d{2})(?:x(\\d{2}))?|(?:(\d{1})(\d{2})(?:[-_ ](\d{2})))?/i;
const yearRegex = /\b(19|20)\d{2}\b/;
const allKeywordsRegex = /\b(2160p|1080p|720p|480p|HDR|WEB[- ]?DL|WEBRIP|BLURAY|REMUX|HDTV|X264|X265|AAC|AC3|DTS|FLAC|HEVC|10bit|H\.?264|265|DDP|ATMOS|mRs|MrTentsaw|ani|batch|tv|AMZN)\b/gi;
const cleaningRegexes = [
  /\(\d{4}\)/g,                                // años (2009)
  /\bSeason\s?\d{1,3}\b/gi,                    // Season 1, Season 27
  /\bS\d{1,2}\b/gi,                            // S01 (sueltos)
  /[-_.]/g,                                    // guiones, puntos por espacios
  /\[.*?\]/g,                                  // etiquetas [EZTV]
  /\b\d{3,4}p\b/gi,                            // resoluciones 1080p
  /\b(web[- ]?dl|webrip|bluray|hdtv|x264|x265|h\.?264|h\.?265|aac|ac3|dts|flac|hevc|10bit|ddp|atmos|amzn|nf|dsnp|ani|mrs|mRs)\b/gi,
  /\s+/g                                       // múltiples espacios por uno
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY + Math.floor(Math.random() * 2000));

function cleanTitle(str) {
  let result = str;
  for (const rx of cleaningRegexes) result = result.replace(rx, ' ');
  return result.trim();
}

function extractDescriptors(...sources) {
  const all = sources.join(' ').match(allKeywordsRegex);
  return all ? [...new Set(all.map(d => d.toUpperCase()))].join(' ') : '';
}

function parseFileName(filePath) {
  const fileName = path.parse(filePath).name.replace(/[_\.]/g, ' ');
  const folderName = path.basename(path.dirname(filePath)).replace(/[_\.]/g, ' ');
  const name = fileName;

  const regexes = [
    /S(?<season>\d{1,2})E(?<start>\d{2})(?:E(?<extra>\d{2}))*?(?:-E?(?<end>\d{2}))?/i,
    /(?<season>\d{1,2})x(?<start>\d{2})(?:x(?<extra>\d{2}))?/i,
    /(?<season>\d)(?<start>\d{2})(?:[-_ ](?<end>\d{2}))?/i
  ];

  let match;
  for (const regex of regexes) {
    match = name.match(regex);
    if (match) break;
  }
  if (!match?.groups?.season || !match?.groups?.start) return null;

  const season = parseInt(match.groups.season);
  if (season === 0) return null;

  const startEp = parseInt(match.groups.start);
  let episodes = [startEp];

  if (match.groups.end) {
    const endEp = parseInt(match.groups.end);
    if (endEp > startEp && endEp - startEp <= 20) {
      episodes = [];
      for (let ep = startEp; ep <= endEp; ep++) episodes.push(ep);
    }
  } else if (match.groups.extra) {
    const extra = parseInt(match.groups.extra);
    if (!isNaN(extra)) episodes.push(extra);
  }

  const extras = [...name.matchAll(/E(\d{2})/gi)].map(m => parseInt(m[1]));
  if (extras.length > 1) episodes = Array.from(new Set(extras));

  const seasonStr = String(season).padStart(2, '0');
  episodes = episodes.map(e => String(e).padStart(2, '0'));

  const seMatch = match[0];
  const seIndex = name.indexOf(seMatch);
  let titleBeforeSE = cleanTitle(name.slice(0, seIndex));

  // 🛠️ Fallback en caso de que no haya título detectado
  if (!titleBeforeSE) {

  titleBeforeSE = folderName
    .replace(/season\s?\d+/i, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(x264|x265|h\.?264|hevc|aac|web[- ]?dl|bluray|webrip|remux|hdtv|10bit|batch|mRs|ani)\b/gi, '')
    .replace(/[-–—\s]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  }
  const descriptors = name.match(allKeywordsRegex);
  const uniqueDescriptors = descriptors
    ? [...new Set(descriptors.map(d => d.toUpperCase()))].join(' ')
    : '';

  return {
    rawTitle: titleBeforeSE,
    season: seasonStr,
    episodes,
    descriptors: uniqueDescriptors
  };
}

async function loadJSON(file) {
  try { return await fs.readJSON(file); } catch { return {}; }
}

async function saveJSON(file, data) {
  try { await fs.writeJSON(file, data, { spaces: 2 }); } catch (e) { console.error(`❌ Error guardando ${file}:`, e.message); }
}

async function fetchSeries(query, year, tmdbCache) {
  const key = `${query.toLowerCase()}|${year || ''}`;
  if (tmdbCache[key]) return tmdbCache[key];

  try {
    const res = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query, language: LANGUAGE, first_air_date_year: year },
      headers: { 'User-Agent': 'EmbySymlink/1.0' }
    });
    if (res.data.results.length) {
      const best = res.data.results.find(r => r.first_air_date?.startsWith(String(year))) || res.data.results[0];
      tmdbCache[key] = best;
      await saveJSON(CACHE_FILE, tmdbCache);
      return best;
    }
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn('⚠️ Rate limit alcanzado, esperando 10s...');
      await sleep(10000);
      return fetchSeries(query, year, tmdbCache);
    }
    console.warn(`❌ Error TMDb: ${query} - ${e.message}`);
  }

  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', {
      params: { t: query, type: 'series', apikey: OMDB_API_KEY, y: year }
    });
    if (omdbRes.data?.Response === 'True') {
      const title = omdbRes.data.Title;
      return fetchSeries(title, year, tmdbCache);
    }
  } catch (e) {
    console.warn(`❌ Error OMDb: ${query} - ${e.message}`);
  }

  return null;
}

async function fetchSeriesFromTMDB(query, yearHint) {
  try {
    const res = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: {
        api_key: TMDB_API_KEY,
        query,
        language: LANGUAGE,
        first_air_date_year: yearHint
      }
    });
    if (res.data.results.length > 0) {
      if (yearHint) {
        const exact = res.data.results.find(r => r.first_air_date?.startsWith(String(yearHint)));
        if (exact) return exact;
      }
      return res.data.results[0];
    }
  } catch (e) {
    console.warn(`❌ Error TMDb: ${query} - ${e.message}`);
  }
  return null;
}

async function fetchSeriesWithFallback(query) {
  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  const yearHint = yearMatch ? yearMatch[0] : undefined;
  const cleanQuery = query.replace(/\b(19|20)\d{2}\b/, '').trim();

  let show = await fetchSeriesFromTMDB(cleanQuery, yearHint);
  if (show) return show;

  try {
    const omdbRes = await axios.get('http://www.omdbapi.com/', {
      params: { t: cleanQuery, type: 'series', apikey: OMDB_API_KEY }
    });
    if (omdbRes.data && omdbRes.data.Response === 'True') {
      const cleanTitle = omdbRes.data.Title;
      show = await fetchSeriesFromTMDB(cleanTitle, yearHint);
      return show;
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

  let parsed = parseFileName(fileName);

  if (!parsed || !parsed.rawTitle) {
    const parentFolder = path.basename(path.dirname(filePath));
    const cleanedFolderTitle = cleanTitle(parentFolder);
    const seMatch = fileName.match(seasonEpisodeRegex);

    if (seMatch) {
      const season = String(parseInt(seMatch[1] || seMatch[3] || seMatch[5])).padStart(2, '0');
      const episode = String(parseInt(seMatch[2] || seMatch[4] || seMatch[6])).padStart(2, '0');
      parsed = {
        rawTitle: cleanedFolderTitle,
        season,
        episodes: [episode],
        descriptors: ''
    };
   // console.log(`📂 Usando nombre de carpeta como título: ${parsed.rawTitle}`);
    } else {
      console.log(`📂 Usando nombre de carpeta como título: ${parsed.rawTitle}`);
      console.warn(`⚠️ No se pudo extraer título de: ${fileName}`);
      return;
    }
  }

  const { rawTitle, season, episodes, descriptors } = parsed;
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

  const showTitle = show.name || rawTitle;
  const showYear = show.first_air_date?.split('-')[0] || yearHint || '0000';
  const baseFolder = path.join(destDir, `${showTitle} (${showYear})`, `Season ${parseInt(season)}`);
  await fs.ensureDir(baseFolder);

  for (const episode of episodes) {
    const destFile = path.join(
      baseFolder,
      `${showTitle} S${season}E${episode}${descriptors ? ' - ' + descriptors : ''}${path.extname(filePath)}`
    );
    if (await fs.pathExists(destFile)) continue;

    if (DRY_RUN) console.log(`[Dry Run] ➤ ${destFile}`);
    else {
      try {
        await fs.symlink(filePath, destFile);
        console.log(`✅ Symlink creado: ${destFile}`);
        linkCache[fileName] = destFile;
        await saveJSON(CACHE_FILE, linkCache);
      } catch (e) {
        console.error(`❌ Error creando symlink: ${destFile} - ${e.message}`);
      }
    }
    await randomDelay();
  }
}

async function fixNames(destDir) {
  console.log(`🔍 Escaneando symlinks y carpetas reales en: ${destDir}\n`);

  const cachePath = path.join(destDir.includes('movies') ? '/media/movies' : '/media/tvshows', '.symlinked-series.json');
  let linkCache = {};
  try {
    linkCache = await fs.readJSON(cachePath);
  } catch {}

  const updatedCache = {};

  const items = await fs.readdir(destDir);
  for (const item of items) {
    if (!item.includes(':')) continue;

    const oldPath = path.join(destDir, item);
    const newName = item.replace(/: /g, ' - ').replace(/:/g, ' -');
    const newPath = path.join(destDir, newName);

    console.log(`🔁 Detectado con ':' → ${item}`);

    if (oldPath === newPath) {
      console.log(`   ❕ Ya está limpio, sin cambios.`);
      continue;
    }

    if (await fs.pathExists(newPath)) {
      console.log(`   ⚠️  No se puede renombrar, ya existe: ${newName}`);
      continue;
    }

    try {
      await fs.rename(oldPath, newPath);
      console.log(`   ✅ Renombrado → ${newName}\n`);

      // Actualiza claves en caché si coinciden con symlink exacto
      for (const [originalName, targetPath] of Object.entries(linkCache)) {
        if (targetPath === oldPath) {
          updatedCache[originalName] = newPath;
        } else {
          updatedCache[originalName] = targetPath;
        }
      }
    } catch (err) {
      console.warn(`   ❌ Error al renombrar ${item}: ${err.message}`);
    }
  }

  if (Object.keys(updatedCache).length > 0) {
    await fs.writeJSON(cachePath, updatedCache, { spaces: 2 });
    console.log(`💾 Caché actualizada con nuevos nombres.`);
  }

  console.log(`✅ Completado.\n`);
}


(async () => {
  if (options.clearCache) await fs.remove(CACHE_FILE);
  const sourceDir = path.resolve(options.source);
  const destDir = path.resolve(options.dest);

  const files = await findVideoFiles(sourceDir);
  const tmdbCache = await loadJSON(CACHE_FILE);
  const linkCache = await loadJSON(CACHE_FILE);

  for (const filePath of files) {
    await createSymlink(filePath, tmdbCache, linkCache, destDir);
  }

  if (options.fixNames) {
  await fixNames(path.resolve(options.dest));
  process.exit(0);
  }

})();
