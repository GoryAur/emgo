require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

program
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/shows/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/anime/')
  .option('--delay <ms>', 'Retraso base entre peticiones (ms)', '2000')
  .option('--dry-run', 'Simular sin crear symlinks')
  .option('--lang <code>', 'Idioma TMDb', 'en-US')
  .parse(process.argv);

const options = program.opts();
const TMDB_API_KEY = process.env.TMDB_API_KEY || process.env.TMDB_API_KEY2;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;

const videoExtensions = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;
const yearRegex = /\b(19|20)\d{2}\b/;
const allKeywordsRegex = /\b(2160p|1080p|720p|480p|HDR|WEB[- ]?DL|WEBRIP|BLURAY|REMUX|HDTV|X264|X265|AAC|AC3|DTS|FLAC|HEVC|10bit|H\.264|265|DDP|ATMOS|AMZN|NF|DSNP)\b/gi;
const cleaningRegexes = [
  /\(\d{4}\)/g, /\[.*?\]/g, /[-_.]/g,
  /\b\d{3,4}p\b/gi, /\b(web[- ]?dl|webrip|bluray|x264|x265|h\.264|hevc|aac|ac3|dts|flac|10bit|ddp|atmos|amzn|nf|dsnp)\b/gi,
  /\s+/g
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

function parseAnimeFileName(filePath) {
  const fileName = path.parse(filePath).name.replace(/[_\.]/g, ' ');
  const folderName = path.basename(path.dirname(filePath)).replace(/[_\.]/g, ' ');

  // Buscar el episodio en el NOMBRE DEL ARCHIVO
  const match = fileName.match(/(?<ep>\d{3})(?!\d)/);
  if (!match?.groups?.ep) {
    console.warn(`⚠️ No se pudo extraer episodio de: ${fileName}`);
    return null;
  }

  const episode = String(parseInt(match.groups.ep)).padStart(3, '0');
  const season = '01';

  // Usar solo carpeta como título base
  let rawTitle = cleanTitle(folderName.replace(/\d{3,4}/g, '').replace(/\[.*?\]/g, ''));
  if (!rawTitle) rawTitle = 'Unknown';

  const descriptors = extractDescriptors(folderName, fileName);

  return {
    rawTitle,
    season,
    episodes: [episode],
    descriptors
  };
}


async function fetchSeries(query, year) {
  try {
    const res = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query, language: LANGUAGE, first_air_date_year: year },
      headers: { 'User-Agent': 'AnimeNoCache/1.0' }
    });

    if (res.data.results.length) {
      const candidates = res.data.results.filter(r =>
        r.genre_ids?.includes(16) &&
        r.origin_country?.includes('JP')
      );

      const best = candidates.find(r => r.first_air_date?.startsWith(String(year))) || candidates[0] || res.data.results[0];
      return best;
    }
  } catch (e) {
    console.warn(`❌ Error TMDb: ${query} - ${e.message}`);
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

async function createSymlink(filePath, destDir) {
  const parsed = parseAnimeFileName(filePath);
  if (!parsed?.rawTitle || parsed.rawTitle.length < 2) return;

  const { rawTitle, season, episodes, descriptors } = parsed;
  const yearHint = (filePath.match(yearRegex) || [])[0];
  const show = await fetchSeries(rawTitle, yearHint);

  if (!show) {
    console.warn(`⚠️ No encontrado en TMDb: ${rawTitle}`);
    return;
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
    if (await fs.pathExists(destFile)) {
      console.log(`⏭ Ya existe: ${destFile}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[Dry Run] ➤ ${destFile}`);
    } else {
      try {
        await fs.symlink(filePath, destFile);
        console.log(`✅ Symlink creado: ${destFile}`);
      } catch (e) {
        console.error(`❌ Error creando symlink: ${destFile} - ${e.message}`);
      }
    }
    await randomDelay();
  }
}

(async () => {
  const sourceDir = path.resolve(options.source);
  const destDir = path.resolve(options.dest);

  const files = await findVideoFiles(sourceDir);
  console.log(`🔍 Archivos encontrados: ${files.length}`);

  for (const filePath of files) {
    try {
      await createSymlink(filePath, destDir);
    } catch (e) {
      console.error(`❌ Error con ${filePath}: ${e.message}`);
    }
  }
})();
