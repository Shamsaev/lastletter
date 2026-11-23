// Text helpers shared by client and server.

/** Language of the words in a game. The UI language is separate (see client/i18n). */
export type Lang = 'en' | 'ru';
export const LANGS: readonly Lang[] = ['en', 'ru'];

/** ЙЦУКЕН → QWERTY by key position (letters only; punctuation keys are dropped). */
const RU_TO_EN: Record<string, string> = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l',
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm',
  ё: '', х: '', ъ: '', ж: '', э: '', б: '', ю: '',
};

/** QWERTY → ЙЦУКЕН by key position, including the punctuation keys that hold Russian letters. */
const EN_TO_RU: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'е',
};

/**
 * Lower-cases, fixes a forgotten keyboard layout and strips everything that isn't a letter of `lang`.
 * en: "фззду" → "apple". ru: "ghbdtn" → "привет", "ёж" → "еж".
 */
export function normalizeInput(raw: string, lang: Lang = 'en'): string {
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (lang === 'en') {
      if (ch >= 'a' && ch <= 'z') out += ch;
      else if (ch in RU_TO_EN) out += RU_TO_EN[ch];
    } else {
      if (ch === 'ё') out += 'е';
      else if (ch >= 'а' && ch <= 'я') out += ch;
      else if (ch in EN_TO_RU) out += EN_TO_RU[ch];
    }
  }
  return out;
}

export const MIN_WORD = 3;
export const MAX_WORD = 30;

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const RU_LETTERS = 'абвгдежзийклмнопрстуфхцчшщъыьэюя'.split('');

/**
 * Russian: a word ending in one of these passes on the letter before it
 * (лошадь → Д, чай → А). Classic rule for Ь/Ъ/Ы; Й is added because almost no nouns start with it.
 */
const RU_SKIP_END = new Set(['ь', 'ъ', 'ы', 'й']);

/** Letters a player can choose to start a round. */
export const PICKABLE: Record<Lang, string[]> = {
  en: LETTERS,
  ru: RU_LETTERS.filter((l) => !RU_SKIP_END.has(l)),
};

/** Letters used when a picker runs out of time: common, friendly starts. */
export const EASY_LETTERS: Record<Lang, string[]> = {
  en: 'abcdefghilmnoprstw'.split(''),
  ru: 'абвгдзклмнопрст'.split(''),
};

/** Index of the letter the next word must start with. */
export function chainLetterIndex(word: string, lang: Lang): number {
  let i = word.length - 1;
  if (lang === 'ru') while (i > 0 && RU_SKIP_END.has(word[i])) i--;
  return i;
}

export function chainLetter(word: string, lang: Lang): string {
  return word[chainLetterIndex(word, lang)];
}

/** Physical key (KeyboardEvent.code) → letter, independent of the OS keyboard layout. */
export function letterFromKeyCode(code: string, lang: Lang): string | null {
  const m = /^Key([A-Z])$/.exec(code);
  const en =
    m?.[1].toLowerCase() ??
    ({ BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`' } as Record<string, string>)[code];
  if (!en) return null;
  const letter = normalizeInput(en, lang);
  return PICKABLE[lang].includes(letter) ? letter : null;
}

export type WordError = 'too_short' | 'too_long' | 'wrong_letter' | 'used' | 'not_word';

/** Checks that do not need the dictionary — used by client for instant hints and by server. */
export function quickCheck(word: string, letter: string, isUsed: (w: string) => boolean): WordError | null {
  if (!word.startsWith(letter)) return 'wrong_letter';
  if (word.length < MIN_WORD) return 'too_short';
  if (word.length > MAX_WORD) return 'too_long';
  if (isUsed(word)) return 'used';
  return null;
}
