// Text helpers shared by client and server.

/** ЙЦУКЕН → QWERTY by key position (letters only; punctuation keys are dropped). */
const RU_TO_EN: Record<string, string> = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l',
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm',
  ё: '', х: '', ъ: '', ж: '', э: '', б: '', ю: '',
};

/** Lower-cases, fixes a forgotten Russian layout and strips everything that is not a-z. */
export function normalizeInput(raw: string): string {
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (ch >= 'a' && ch <= 'z') out += ch;
    else if (ch in RU_TO_EN) out += RU_TO_EN[ch];
  }
  return out;
}

/** True if the raw input contained Cyrillic that got converted (to show a small hint). */
export function hadCyrillic(raw: string): boolean {
  return /[а-яё]/i.test(raw);
}

export const MIN_WORD = 3;
export const MAX_WORD = 30;
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
/** Letters used when a picker runs out of time: common, friendly starts. */
export const EASY_LETTERS = 'abcdefghilmnoprstw'.split('');

export type WordError =
  | 'too_short'
  | 'too_long'
  | 'wrong_letter'
  | 'used'
  | 'not_word';

/** Checks that do not need the dictionary — used by client for instant hints and by server. */
export function quickCheck(word: string, letter: string, isUsed: (w: string) => boolean): WordError | null {
  if (!word.startsWith(letter)) return 'wrong_letter';
  if (word.length < MIN_WORD) return 'too_short';
  if (word.length > MAX_WORD) return 'too_long';
  if (isUsed(word)) return 'used';
  return null;
}
