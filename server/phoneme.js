import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const __dirname = import.meta.url.slice(0, import.meta.url.lastIndexOf('/'));

let config = null;
let symbolToId = null;

async function loadConfigAsync() {
  if (config) return config;
  const configPath = join(__dirname, 'dist', 'models', 'config.json');
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  symbolToId = null; // rebuild map
  return config;
}

async function getConfig() {
  if (!config) {
    config = await loadConfigAsync();
  }
  return config;
}

async function buildSymbolToId() {
  if (symbolToId) return symbolToId;
  const c = await getConfig();
  const local = {};
  for (const [symbol, ids] of Object.entries(c.phoneme_id_map)) {
    for (let i = 0; i < ids.length; i++) {
      local[[symbol, i].join('|')] = ids[i];
    }
  }
  symbolToId = local;
  return local;
}

const idBySymbol = async (symbol) => {
  const local = await buildSymbolToId();
  const id = local[symbol];
  if (id !== undefined) return id;
  // Common fallback for Indonesian letters not explicitly in the map.
  if (/[a-z]/.test(symbol)) {
    return local[symbol.toLowerCase()] ?? local[symbol.toUpperCase()] ?? 0;
  }
  return 0;
};

export async function textToPhonemeIds(text) {
  const t = text.trim();
  if (!t) return [];

  // Replace Indonesian punctuation with the model's token equivalents.
  let normalized = t
    .replace(/"/g, "'")
    .replace(/\./g, '.')
    .replace(/,/g, ',')
    .replace(/\?/g, '?')
    .replace(/!/g, '!')
    .replace(/:/g, ':')
    .replace(/;/g, ';')
    .replace(/\(/g, '(')
    .replace(/\)/g, ')')
    .replace(/-/g, '-')
    .replace(/\s+/g, ' ');

  const ids = [];
  for (const ch of normalized) {
    const id = await idBySymbol(ch);
    if (id >= 0 && id < (await getConfig()).num_symbols) {
      ids.push(id);
    }
  }
  return ids;
}

export async function getNumSymbols() {
  return (await getConfig()).num_symbols;
}

export { loadConfigAsync as loadConfig };
