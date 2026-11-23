import { readFileSync } from 'node:fs';
import wordListPath from 'word-list';
import { MAX_WORD, MIN_WORD } from '../shared/text.js';

let cache: Set<string> | null = null;

/** ~270k English words (sindresorhus/word-list, MIT). Loaded once, kept in memory (~20 MB). */
export function loadDictionary(): Set<string> {
  if (cache) return cache;
  const set = new Set<string>();
  for (const w of readFileSync(wordListPath, 'utf8').split('\n')) {
    if (w.length >= MIN_WORD && w.length <= MAX_WORD && /^[a-z]+$/.test(w)) set.add(w);
  }
  cache = set;
  return set;
}
