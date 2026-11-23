import type { Lang } from '../shared/text';

type Err = (letter: string, lang: Lang) => string;

const ru = {
  rulesTitle: 'Правила',
  terms: 'Условия использования',
  privacy: 'Конфиденциальность',
  rules: (sec: number, discord: boolean, lang?: Lang) => [
    'Играют от 2 человек, ходы идут по кругу.',
    'Первый в круге выбирает букву, следующий пишет слово на эту букву.',
    'Дальше каждый пишет слово на последнюю букву предыдущего.',
    ...(lang === 'en'
      ? ['Слова английские, в любой форме.']
      : lang === 'ru'
        ? [
            'Слова русские: существительные в именительном падеже, единственном числе — «кот», а не «коты». Ё = Е.',
            'Если слово кончается на Ь, Ъ, Ы или Й — следующее на предпоследнюю букву: лошадь → Д, чай → А.',
          ]
        : ['Язык слов — английский или русский — выбирается в лобби.']),
    'Слова не повторяются до конца партии. Минимум 3 буквы.',
    `На ход ${sec} секунд. Не успел — минус ♥.`,
    'Кто потерял ♥, начинает новый круг — выбирает букву.',
    'У каждого 3 ♥. Последний оставшийся побеждает.',
    'Неверное слово не штрафуется — пробуй ещё, пока идёт время.',
    'Можно сдаться кнопкой 🏳 — нажми её два раза.',
    'Раскладку клавиатуры переключать не нужно — буквы переведутся сами.',
    ...(discord ? ['Результаты партий и статистика приходят в чат голосового канала.'] : []),
  ],
  yourName: 'Твоё имя',
  createRoom: 'Создать комнату',
  join: 'Войти',
  invite: 'Скопировать ссылку',
  copied: 'Ссылка скопирована',
  turnTime: 'Время на ход',
  sec: 'с',
  start: 'Начать',
  yourTurn: 'Твой ход',
  wordOn: 'слово на',
  turnOf: (n: string) => `Ходит ${n}`,
  pickFor: (n: string) => `Выбери букву для ${n}`,
  picking: (n: string) => `${n} выбирает букву`,
  errors: {
    wrong_letter: (l) => `Слово должно начинаться на ${l}`,
    too_short: () => 'Минимум 3 буквы',
    too_long: () => 'Слишком длинное слово',
    used: () => 'Это слово уже было',
    not_word: (_l, lang) => (lang === 'ru' ? 'Нет в словаре — нужно существительное в именительном падеже' : 'Такого слова нет в словаре'),
    slow_down: () => 'Не так быстро',
    not_your_turn: () => 'Сейчас не твой ход',
  } satisfies Record<string, Err> as Record<'wrong_letter' | 'too_short' | 'too_long' | 'used' | 'not_word' | 'slow_down' | 'not_your_turn', Err>,
  wordsLang: 'Слова',
  langName: { en: 'English', ru: 'Русские' } as Record<Lang, string>,
  evTimeout: (n: string) => `${n} не успел · −♥`,
  evOut: (n: string) => `${n} выбывает`,
  evLeft: (n: string) => `${n} покинул игру`,
  evSurrender: (n: string) => `${n} сдался`,
  surrender: 'Сдаться',
  surrenderConfirm: 'Точно сдаться?',
  evAuto: (l: string) => `Время вышло — случайная буква ${l}`,
  win: (n: string) => `${n} победил!`,
  youWin: 'Ты победил!',
  nobody: 'Победителя нет',
  again: 'Играть снова',
  toLobby: 'Лобби',
  reconnecting: 'Переподключение…',
  connecting: 'Подключение…',
  you: 'ты',
  authFail: 'Не удалось войти через Discord. Перезапусти активность.',
  mute: 'Звук',
};

type Dict = typeof ru;

const en: Dict = {
  rulesTitle: 'Rules',
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  rules: (sec, discord, lang) => [
    '2 or more players, turns go around the circle.',
    'The first player of a round picks a letter; the next one writes a word starting with it.',
    'Then each word starts with the last letter of the previous one.',
    ...(lang === 'en'
      ? ['English words, any form.']
      : lang === 'ru'
        ? [
            'Russian words: nouns in nominative singular — «кот», not «коты». Ё = Е.',
            'If a word ends in Ь, Ъ, Ы or Й, the next one starts with the letter before it: лошадь → Д, чай → А.',
          ]
        : ['Word language — English or Russian — is chosen in the lobby.']),
    'No word can be used twice in a game. At least 3 letters.',
    `${sec} seconds per turn. Too slow — lose a ♥.`,
    'Whoever loses a ♥ starts the next round by picking a letter.',
    'Everyone has 3 ♥. Last one standing wins.',
    'Wrong words aren’t penalized — keep trying while the timer runs.',
    'Give up any time with the 🏳 button — tap it twice.',
    'No need to switch keyboard layout — letters convert automatically.',
    ...(discord ? ['Results and stats are posted to the voice channel chat.'] : []),
  ],
  yourName: 'Your name',
  createRoom: 'Create room',
  join: 'Join',
  invite: 'Copy invite link',
  copied: 'Link copied',
  turnTime: 'Time per turn',
  sec: 's',
  start: 'Start',
  yourTurn: 'Your turn',
  wordOn: 'word starting with',
  turnOf: (n) => `${n}’s turn`,
  pickFor: (n) => `Pick a letter for ${n}`,
  picking: (n) => `${n} is picking a letter`,
  errors: {
    wrong_letter: (l) => `Must start with ${l}`,
    too_short: () => 'At least 3 letters',
    too_long: () => 'Too long',
    used: () => 'Already used',
    not_word: (_l, lang) => (lang === 'ru' ? 'Not in the dictionary — must be a noun, nominative singular' : 'Not in the dictionary'),
    slow_down: () => 'Slow down',
    not_your_turn: () => 'Not your turn',
  },
  wordsLang: 'Words',
  langName: { en: 'English', ru: 'Russian' },
  evTimeout: (n) => `${n} ran out of time · −♥`,
  evOut: (n) => `${n} is out`,
  evLeft: (n) => `${n} left the game`,
  evSurrender: (n) => `${n} gave up`,
  surrender: 'Give up',
  surrenderConfirm: 'Sure? Give up',
  evAuto: (l) => `Time’s up — random letter ${l}`,
  win: (n) => `${n} wins!`,
  youWin: 'You win!',
  nobody: 'No winner',
  again: 'Play again',
  toLobby: 'Lobby',
  reconnecting: 'Reconnecting…',
  connecting: 'Connecting…',
  you: 'you',
  authFail: 'Discord sign-in failed. Restart the activity.',
  mute: 'Sound',
};

const forced = new URLSearchParams(location.search).get('lang');
const lang = (forced ?? navigator.language ?? 'en').toLowerCase();
export const t: Dict = lang.startsWith('ru') || lang.startsWith('uk') || lang.startsWith('be') ? ru : en;
