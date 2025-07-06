#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { program } = require('commander');

// --- Opciones de Línea de Comandos ---
program
  .option('-s, --source <path>', 'Directorio fuente', '/mnt/torrents/shows/')
  .option('-d, --dest <path>', 'Directorio destino', '/media/tvshows/')
  .option('--delay <ms>', 'Retraso entre peticiones a la API (ms)', '1000')
  .option('--dry-run', 'Simular sin crear enlaces simbólicos')
  .option('--lang <code>', 'Código de idioma para TMDb', 'en-US')
  .option('--clear-cache', 'Borrar la caché de enlaces simbólicos antes de empezar')
  .parse(process.argv);

const options = program.opts();

// --- Configuración ---
const TMDB_API_KEY = process.env.TMDB_API_KEY; // Reemplaza con tu clave si es necesario
const OMDB_API_KEY = process.env.OMDB_API_KEY; // Reemplaza con tu clave si es necesario
const LANGUAGE = options.lang;
const DELAY = parseInt(options.delay, 10);
const DRY_RUN = !!options.dryRun;
const CACHE_FILE = '.symlinked-series.json';
const SOURCE_DIR = path.resolve(options.source);
const DEST_DIR = path.resolve(options.dest);

// --- Expresiones Regulares ---
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|m4v)$/i;
const SEASON_EPISODE_REGEX = [
    /S(?<season>\d{1,2})E(?<start>\d{2})(?:-?E(?<end>\d{2}))?/i, // S01E01, S01E01-E03
    /(?<season>\d{1,2})x(?<start>\d{2})(?:-?x(?<end>\d{2}))?/i,   // 1x01, 1x01-x03
    /(?<!\d)(?<season>\d)(?<start>\d{2})(?!\d)/i // 101 (sin S/E)
];
const CLEANING_REGEXES = [
    /\b(2160p|1080p|720p|480p|HDR|WEB-?DL|WEBRIP|BLURAY|REMUX|HDTV|x264|x265|HEVC|AAC|AC3|DTS|10bit|DDP|ATMOS|AMZN|NF|DSNP)\b/gi,
    /\[.*?\]/g, // Tags como [i_c]
    /\(\d{4}\)/g, // Año como (2023)
    /[-._]/g, // Separadores
    /\s{2,}/g // Múltiples espacios
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Busca recursivamente archivos de video en un directorio.
 * @param {string} dir - Directorio a escanear.
 * @returns {Promise<string[]>} - Lista de rutas de archivos de video.
 */
async function findVideoFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(await findVideoFiles(fullPath));
        } else if (entry.isFile() && VIDEO_EXTENSIONS.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Limpia una cadena de título de serie.
 * @param {string} title - El título a limpiar.
 * @returns {string} - El título limpio.
 */
function cleanTitle(title) {
    let cleanedTitle = title;
    for (const regex of CLEANING_REGEXES) {
        cleanedTitle = cleanedTitle.replace(regex, ' ');
    }
    return cleanedTitle.trim();
}

/**
 * Analiza un nombre de archivo para extraer el título, la temporada y los episodios.
 * @param {string} filename - El nombre del archivo a analizar.
 * @returns {{rawTitle: string, season: string, episodes: string[]}|null}
 */
function parseFileName(filename) {
    const baseName = path.parse(filename).name.replace(/[._]/g, ' ');
    let match;
    for (const regex of SEASON_EPISODE_REGEX) {
        match = baseName.match(regex);
        if (match) break;
    }

    if (!match || !match.groups) {
        return null;
    }

    const { season, start, end } = match.groups;
    const seasonNum = parseInt(season, 10);
    if (seasonNum === 0) {
        console.warn(`⏭️  Ignorando temporada 0 (especial): ${filename}`);
        return null;
    }

    let episodes = [];
    const startEp = parseInt(start, 10);
    if (end) {
        const endEp = parseInt(end, 10);
        for (let i = startEp; i <= endEp; i++) {
            episodes.push(String(i).padStart(2, '0'));
        }
    } else {
        episodes.push(String(startEp).padStart(2, '0'));
    }

    const titleIndex = match.index;
    const rawTitle = cleanTitle(baseName.substring(0, titleIndex));

    return {
        rawTitle,
        season: String(seasonNum).padStart(2, '0'),
        episodes
    };
}

/**
 * Busca una serie en TMDb.
 * @param {string} query - El título de la serie.
 * @returns {Promise<any|null>} - El resultado de la serie de TMDb.
 */
async function fetchFromTMDB(query) {
    try {
        const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
            params: {
                api_key: TMDB_API_KEY,
                query: query,
                language: LANGUAGE
            }
        });
        return response.data.results[0] || null;
    } catch (error) {
        console.error(`❌ Error al buscar en TMDb "${query}": ${error.message}`);
        return null;
    }
}

/**
 * Procesa un solo archivo de video para crear un enlace simbólico.
 * @param {string} filePath - La ruta al archivo de video.
 * @param {object} tmdbCache - Caché en memoria para los resultados de TMDB.
 * @param {object} symlinkCache - Caché persistente de enlaces simbólicos creados.
 */
async function processFile(filePath, tmdbCache, symlinkCache) {
    const fileName = path.basename(filePath);

    if (symlinkCache[fileName] && await fs.pathExists(symlinkCache[fileName])) {
        // console.log(`⏭️  Ya enlazado: ${fileName}`);
        return;
    }

    let parsed = parseFileName(fileName);
    if (!parsed) {
        console.warn(`⚠️  No se pudo analizar temporada/episodio para: ${fileName}`);
        return;
    }

    const { rawTitle, season, episodes } = parsed;
    if (!rawTitle) {
        console.warn(`⚠️  No se pudo extraer el título para: ${fileName}`);
        return;
    }

    const cacheKey = rawTitle.toLowerCase();
    if (!tmdbCache[cacheKey]) {
        console.log(`🔍 Buscando en TMDb: "${rawTitle}"`);
        tmdbCache[cacheKey] = await fetchFromTMDB(rawTitle);
        await sleep(DELAY);
    }

    const show = tmdbCache[cacheKey];
    if (!show) {
        console.warn(`🚫 No encontrado en TMDb: ${rawTitle}`);
        return;
    }

    const showTitle = show.name.replace(/[:]/g, ''); // Eliminar caracteres inválidos para nombres de archivo
    const year = show.first_air_date ? show.first_air_date.split('-')[0] : 'N/A';
    const seasonFolder = path.join(DEST_DIR, `${showTitle} (${year})`, `Season ${parseInt(season, 10)}`);

    for (const episode of episodes) {
        const ext = path.extname(fileName);
        const destFileName = `${showTitle} - S${season}E${episode}${ext}`;
        const destPath = path.join(seasonFolder, destFileName);

        if (await fs.pathExists(destPath)) {
            // console.log(`⏭️  El archivo de destino ya existe: ${destPath}`);
            continue;
        }

        if (DRY_RUN) {
            console.log(`[SIMULACIÓN] Enlace simbólico: "${filePath}" -> "${destPath}"`);
        } else {
            try {
                await fs.ensureDir(seasonFolder);
                await fs.symlink(filePath, destPath);
                console.log(`✅ Creado: ${destPath}`);
                symlinkCache[fileName] = destPath;
            } catch (error) {
                console.error(`❌ Error al crear enlace simbólico para "${destPath}": ${error.message}`);
            }
        }
    }
}

/**
 * Función principal para ejecutar el script.
 */
async function main() {
    console.log('🚀 Iniciando script de enlaces simbólicos para series...');
    if (DRY_RUN) {
        console.log('✨ MODO SIMULACIÓN: No se realizarán cambios en el sistema de archivos.');
    }

    if (options.clearCache) {
        try {
            await fs.remove(CACHE_FILE);
            console.log('🗑️  Caché de enlaces simbólicos borrada.');
        } catch (error) {
            if (error.code !== 'ENOENT') { // Ignorar si el archivo no existe
                console.error(`❌ Error al borrar la caché: ${error.message}`);
            }
        }
    }

    let symlinkCache;
    try {
        symlinkCache = await fs.readJson(CACHE_FILE, { throws: false }) || {};
    } catch {
        symlinkCache = {};
    }

    const videoFiles = await findVideoFiles(SOURCE_DIR);
    console.log(`ℹ️  Se encontraron ${videoFiles.length} archivos de video.`);

    const tmdbCache = {};

    for (const filePath of videoFiles) {
        await processFile(filePath, tmdbCache, symlinkCache);
    }

    if (!DRY_RUN) {
        try {
            await fs.writeJson(CACHE_FILE, symlinkCache, { spaces: 2 });
            console.log('💾 Caché de enlaces simbólicos guardada.');
        } catch (error) {
            console.error(`❌ Error al guardar la caché: ${error.message}`);
        }
    }

    console.log('🏁 Proceso completado.');
}

main().catch(error => {
    console.error('💥 Error fatal:', error);
    process.exit(1);
});
