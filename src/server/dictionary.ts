import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import wordListPath from 'word-list';
import { MAX_WORD, MIN_WORD, normalizeInput, type Lang } from '../shared/text.js';

const cache = new Map<Lang, Set<string>>();

const SOURCES: Record<Lang, { file: string; pattern: RegExp }> = {
  // ~270k English words, any form (sindresorhus/word-list, MIT)
  en: { file: wordListPath, pattern: /^[a-z]+$/ },
  // ~51k Russian nouns, nominative singular (Harrix/Russian-Nouns, MIT) — see dict/README.md
  ru: { file: fileURLToPath(new URL('./dict/ru-nouns.txt', import.meta.url)), pattern: /^[а-я]+$/ },
};

/** Loaded once per language and kept in memory. Russian is stored with ё → е, like player input. */
export function loadDictionary(lang: Lang = 'en'): Set<string> {
  const hit = cache.get(lang);
  if (hit) return hit;
  const { file, pattern } = SOURCES[lang];
  const set = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const w = lang === 'ru' ? normalizeInput(line.trim(), 'ru') : line.trim();
    if (w.length >= MIN_WORD && w.length <= MAX_WORD && pattern.test(w)) set.add(w);
  }
  cache.set(lang, set);
  return set;
}
