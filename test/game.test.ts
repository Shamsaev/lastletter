import { describe, expect, it } from 'vitest';
import { Game, MAX_HP, PICK_MS, RECONNECT_GRACE_MS } from '../src/shared/game';
import { PICKABLE, chainLetter, letterFromKeyCode, normalizeInput, quickCheck } from '../src/shared/text';

const WORDS = new Set([
  'apple', 'egg', 'eagle', 'gate', 'elephant', 'tiger', 'rabbit', 'table', 'echo', 'orange', 'tree',
  'cat', 'tea', 'ant', 'teeth', 'house', 'eel', 'lemon', 'night', 'tent', 'tap', 'pear', 'rat', 'ear',
]);
const isWord = (w: string) => WORDS.has(w);
const noShuffle = () => 0.999999; // Fisher-Yates with rng≈1 keeps the original order

const A = { id: 'a', name: 'Alice', avatar: null };
const B = { id: 'b', name: 'Bob', avatar: null };
const C = { id: 'c', name: 'Cid', avatar: null };

function setup(players = [A, B], t = 0) {
  const g = new Game(isWord);
  players.forEach((p) => g.join(p));
  expect(g.start(players[0].id, t, noShuffle)).toBe(true);
  return g;
}

describe('text helpers', () => {
  it('normalizes case, junk and Russian layout', () => {
    expect(normalizeInput('  Apple! ')).toBe('apple');
    expect(normalizeInput('фззду')).toBe('apple');
    expect(normalizeInput('ЕфИду')).toBe('table');
    expect(normalizeInput("don't")).toBe('dont');
  });

  it('quickCheck order: letter, length, used', () => {
    const none = () => false;
    expect(quickCheck('apple', 'b', none)).toBe('wrong_letter');
    expect(quickCheck('ab', 'a', none)).toBe('too_short');
    expect(quickCheck('apple', 'a', (w) => w === 'apple')).toBe('used');
    expect(quickCheck('apple', 'a', none)).toBeNull();
  });
});

describe('lobby', () => {
  it('needs at least two members to start', () => {
    const g = new Game(isWord);
    g.join(A);
    expect(g.start('a', 0)).toBe(false);
    g.join(B);
    expect(g.start('a', 0)).toBe(true);
    expect(g.phase).toBe('picking');
  });

  it('only members may start; anyone of them can', () => {
    const g = new Game(isWord);
    g.join(A);
    g.join(B);
    expect(g.start('stranger', 0)).toBe(false);
    expect(g.start('b', 0)).toBe(true);
  });

  it('turn time setting only accepts known values and only in lobby', () => {
    const g = new Game(isWord);
    g.join(A);
    g.join(B);
    expect(g.setTurnSeconds('a', 20)).toBe(true);
    expect(g.setTurnSeconds('a', 7)).toBe(false);
    g.start('a', 0);
    expect(g.setTurnSeconds('a', 10)).toBe(false);
    expect(g.settings.turnSeconds).toBe(20);
  });

  it('everyone starts with full hp', () => {
    const g = setup([A, B, C]);
    expect(g.players.map((p) => p.hp)).toEqual([MAX_HP, MAX_HP, MAX_HP]);
  });
});

describe('round flow', () => {
  it('picker chooses letter, NEXT player answers, chain uses last letter', () => {
    const g = setup([A, B, C]);
    expect(g.turnId).toBe('a');
    expect(g.snapshot(0).nextId).toBe('b');
    expect(g.pick('b', 'x', 0)).toBe(false); // not b's pick
    expect(g.pick('a', 'A', 0)).toBe(true);
    expect(g.phase).toBe('typing');
    expect(g.turnId).toBe('b');
    expect(g.letter).toBe('a');
    expect(g.submit('b', 'Apple', 1)).toEqual({ ok: true });
    expect(g.turnId).toBe('c');
    expect(g.letter).toBe('e');
    expect(g.submit('c', 'egg', 2)).toEqual({ ok: true });
    expect(g.turnId).toBe('a'); // picker plays in the chain too
    expect(g.letter).toBe('g');
  });

  it('accepts a word typed in Russian layout', () => {
    const g = setup();
    g.pick('a', 'a', 0);
    expect(g.submit('b', 'фззду', 1)).toEqual({ ok: true });
    expect(g.chain.at(-1)!.word).toBe('apple');
  });

  it('rejects wrong letter, too short, unknown and repeated words without penalty', () => {
    const g = setup();
    g.pick('a', 'e', 0);
    expect(g.submit('b', 'apple', 1)).toEqual({ ok: false, error: 'wrong_letter' });
    expect(g.submit('b', 'ee', 1)).toEqual({ ok: false, error: 'too_short' });
    expect(g.submit('b', 'eqwerty', 1)).toEqual({ ok: false, error: 'not_word' });
    expect(g.submit('a', 'egg', 1)).toEqual({ ok: false, error: 'not_your_turn' });
    expect(g.submit('b', 'echo', 1)).toEqual({ ok: true });
    expect(g.submit('a', 'orange', 2)).toEqual({ ok: true });
    expect(g.submit('b', 'eagle', 3)).toEqual({ ok: true });
    expect(g.submit('a', 'egg', 4)).toEqual({ ok: true });
    expect(g.submit('b', 'gate', 5)).toEqual({ ok: true });
    expect(g.submit('a', 'echo', 6)).toEqual({ ok: false, error: 'used' });
    expect(g.players.every((p) => p.hp === MAX_HP)).toBe(true);
  });

  it('used words persist across rounds', () => {
    const g = setup();
    g.pick('a', 'a', 0);
    g.submit('b', 'apple', 0);
    g.tick(100_000); // a times out
    expect(g.phase).toBe('picking');
    expect(g.turnId).toBe('a');
    g.pick('a', 'a', 100_000);
    expect(g.submit('b', 'apple', 100_001)).toEqual({ ok: false, error: 'used' });
  });
});

describe('timeouts and hp', () => {
  it('silent player loses 1 hp and starts next round by picking', () => {
    const g = setup([A, B, C]);
    g.pick('a', 'a', 0);
    const deadline = g.deadline!;
    expect(g.tick(deadline - 1)).toBe(false);
    expect(g.tick(deadline)).toBe(true);
    expect(g.player('b')!.hp).toBe(MAX_HP - 1);
    expect(g.phase).toBe('picking');
    expect(g.turnId).toBe('b');
    expect(g.snapshot(deadline).nextId).toBe('c');
    expect(g.snapshot(deadline).events.at(-1)!.e).toEqual({ kind: 'timeout', by: 'b', hp: 2 });
  });

  it('pick timeout chooses a letter automatically with no penalty', () => {
    const g = setup();
    expect(g.tick(PICK_MS)).toBe(true);
    expect(g.phase).toBe('typing');
    expect(g.turnId).toBe('b');
    expect(g.letter).toMatch(/^[a-z]$/);
    expect(g.player('a')!.hp).toBe(MAX_HP);
  });

  it('three timeouts eliminate; last one alive wins (2 players)', () => {
    const g = setup();
    let t = 0;
    g.pick('a', 'a', t);
    for (let i = 0; i < 3; i++) {
      // b is always the one answering: after timeout b picks, a answers... make a answer and b fail
      t = g.deadline!;
      g.tick(t);
      if (g.phase === 'over') break;
      // b picks now, a must answer
      expect(g.turnId).toBe('b');
      g.pick('b', 't', t);
      g.submit('a', ['tea', 'tent', 'teeth'][i], t);
      // now b must answer and will time out on next loop iteration
    }
    expect(g.phase).toBe('over');
    expect(g.winnerId).toBe('a');
    expect(g.player('b')!.place).toBe(2);
    expect(g.player('a')!.place).toBe(1);
  });

  it('eliminated player is skipped; next alive picks after elimination', () => {
    const g = setup([A, B, C]);
    g.player('b')!.hp = 1;
    g.pick('a', 'a', 0);
    g.tick(g.deadline!); // b dies
    expect(g.player('b')!.hp).toBe(0);
    expect(g.player('b')!.place).toBe(3);
    expect(g.phase).toBe('picking');
    expect(g.turnId).toBe('c');
    expect(g.snapshot(0).nextId).toBe('a');
    g.pick('c', 'e', 0);
    expect(g.turnId).toBe('a');
    g.submit('a', 'egg', 0);
    expect(g.turnId).toBe('c'); // b skipped
  });
});

describe('turn time', () => {
  it('defaults to 15s and never speeds up', () => {
    const g = setup();
    expect(g.settings.turnSeconds).toBe(15);
    g.pick('a', 'e', 0);
    const words = ['echo', 'orange', 'eagle', 'egg', 'gate', 'elephant', 'tiger', 'rabbit', 'tree', 'eel', 'lemon', 'night'];
    for (const w of words) {
      expect(g.turnMs).toBe(15_000);
      expect(g.submit(g.turnId!, w, 0)).toEqual({ ok: true });
    }
    expect(g.turnMs).toBe(15_000);
  });
});

describe('result', () => {
  it('counts words per player, places, longest word', () => {
    const g = setup([A, B, C]);
    g.pick('a', 'e', 0);
    g.submit('b', 'elephant', 0);
    g.submit('c', 'tea', 0);
    g.submit('a', 'ant', 0);
    g.player('b')!.hp = 1;
    g.player('c')!.hp = 1;
    g.tick(g.deadline!); // b out (place 3)
    g.pick('c', 't', g.deadline!); // c picks for a
    g.submit('a', 'tiger', 0);
    g.tick(g.deadline!); // c out (place 2)
    expect(g.result()).toEqual({
      winnerId: 'a',
      players: [
        { id: 'a', name: 'Alice', place: 1, words: 2 },
        { id: 'c', name: 'Cid', place: 2, words: 1 },
        { id: 'b', name: 'Bob', place: 3, words: 1 },
      ],
      totalWords: 4,
      longest: { word: 'elephant', by: 'b', round: 1 },
    });
  });

  it('is null while the game is running', () => {
    expect(setup().result()).toBeNull();
  });
});

describe('disconnects', () => {
  it('reconnect within grace keeps the seat', () => {
    const g = setup([A, B, C]);
    g.leave('c', 0);
    expect(g.player('c')!.connected).toBe(false);
    g.tick(RECONNECT_GRACE_MS - 1);
    g.join(C);
    g.tick(RECONNECT_GRACE_MS + 10);
    expect(g.player('c')!.hp).toBe(MAX_HP);
    expect(g.player('c')!.connected).toBe(true);
  });

  it('gone longer than grace → out; if it was their turn the next player picks', () => {
    const g = setup([A, B, C]);
    g.settings.turnSeconds = 20;
    g.pick('a', 'a', 0); // b's turn, deadline 20s
    g.leave('b', 0);
    g.tick(RECONNECT_GRACE_MS - 1); // still inside grace and inside b's 20s turn
    expect(g.player('b')!.hp).toBe(MAX_HP);
    g.deadline = 1e9; // isolate the grace path from the turn timer
    g.tick(RECONNECT_GRACE_MS);
    expect(g.player('b')!.hp).toBe(0);
    expect(g.phase).toBe('picking');
    expect(g.turnId).toBe('c');
  });

  it('opponent leaving in a 2-player game gives the win', () => {
    const g = setup();
    g.leave('b', 0);
    g.deadline = 1e9;
    g.tick(RECONNECT_GRACE_MS);
    expect(g.phase).toBe('over');
    expect(g.winnerId).toBe('a');
  });

  it('late joiner is a spectator and plays the next game', () => {
    const g = setup();
    g.join(C);
    expect(g.player('c')).toBeUndefined();
    expect(g.snapshot(0).members.map((m) => m.id)).toContain('c');
    g.leave('b', 0);
    g.deadline = 1e9;
    g.tick(RECONNECT_GRACE_MS);
    expect(g.phase).toBe('over');
    expect(g.start('c', 0)).toBe(true);
    expect(g.players.map((p) => p.id).sort()).toEqual(['a', 'c']);
  });
});

describe('restart', () => {
  it('play again resets hp, words and keeps settings', () => {
    const g = setup();
    g.pick('a', 'a', 0);
    g.submit('b', 'apple', 0);
    g.player('a')!.hp = 1;
    g.tick(g.deadline!); // a dies
    expect(g.phase).toBe('over');
    g.setTurnSeconds('a', 10);
    expect(g.start('a', 1)).toBe(true);
    expect(g.used.size).toBe(0);
    expect(g.players.every((p) => p.hp === MAX_HP)).toBe(true);
    expect(g.settings.turnSeconds).toBe(10);
  });

  it('back to lobby from results', () => {
    const g = setup();
    g.player('b')!.hp = 1;
    g.pick('a', 'a', 0);
    g.tick(g.deadline!);
    expect(g.toLobby('a')).toBe(true);
    expect(g.phase).toBe('lobby');
    expect(g.players).toEqual([]);
  });
});

describe('rounds', () => {
  it('chain entries carry the round; a timeout starts a new round', () => {
    const g = setup();
    const r1 = g.round;
    g.pick('a', 'a', 0);
    g.submit('b', 'apple', 0);
    expect(g.chain.at(-1)!.round).toBe(r1);
    g.tick(g.deadline!);
    expect(g.round).toBe(r1 + 1);
  });
});

describe('surrender', () => {
  it('on your own turn: out immediately, next player picks a new letter', () => {
    const g = setup([A, B, C]);
    g.pick('a', 'a', 0); // b's turn
    expect(g.surrender('b', 5)).toBe(true);
    expect(g.player('b')!.hp).toBe(0);
    expect(g.player('b')!.place).toBe(3);
    expect(g.phase).toBe('picking');
    expect(g.turnId).toBe('c');
    expect(g.snapshot(5).events.at(-1)!.e).toEqual({ kind: 'out', by: 'b', reason: 'surrender' });
  });

  it('not on your turn: the round goes on, you are skipped', () => {
    const g = setup([A, B, C]);
    g.pick('a', 'a', 0); // b's turn
    expect(g.surrender('c', 1)).toBe(true);
    expect(g.phase).toBe('typing');
    expect(g.turnId).toBe('b');
    g.submit('b', 'apple', 2);
    expect(g.turnId).toBe('a'); // c skipped
  });

  it('in a 2-player game the other player wins; result counts the surrenderer', () => {
    const g = setup();
    g.pick('a', 'a', 0);
    g.surrender('a', 1);
    expect(g.phase).toBe('over');
    expect(g.winnerId).toBe('b');
    expect(g.result()!.players.map((p) => [p.id, p.place])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });

  it('cannot surrender twice, outside a game, or as a spectator', () => {
    const g = setup([A, B, C]);
    g.join({ id: 'd', name: 'Dan', avatar: null });
    expect(g.surrender('d', 0)).toBe(false);
    expect(g.surrender('a', 0)).toBe(true);
    expect(g.surrender('a', 0)).toBe(false);
    const lobby = new Game(isWord);
    lobby.join(A);
    expect(lobby.surrender('a', 0)).toBe(false);
  });
});

describe('russian mode — text', () => {
  it('normalizes Russian, ё → е, fixes a forgotten English layout', () => {
    expect(normalizeInput('  Кот! ', 'ru')).toBe('кот');
    expect(normalizeInput('Ёжик', 'ru')).toBe('ежик');
    expect(normalizeInput('ghbdtn', 'ru')).toBe('привет');
    expect(normalizeInput('[kt,', 'ru')).toBe('хлеб'); // punctuation keys hold х ж э б ю
    expect(normalizeInput('apple', 'en')).toBe('apple'); // English mode untouched
  });

  it('Ь Ъ Ы Й at the end pass on the previous letter', () => {
    expect(chainLetter('кот', 'ru')).toBe('т');
    expect(chainLetter('лошадь', 'ru')).toBe('д');
    expect(chainLetter('чай', 'ru')).toBe('а');
    expect(chainLetter('сыры', 'ru')).toBe('р');
    expect(chainLetter('obey', 'en')).toBe('y'); // only Russian skips
  });

  it('pickable letters skip ъ ы ь й and ё', () => {
    expect(PICKABLE.ru).toHaveLength(28);
    for (const l of ['ъ', 'ы', 'ь', 'й', 'ё']) expect(PICKABLE.ru).not.toContain(l);
  });

  it('physical keys map to the right alphabet', () => {
    expect(letterFromKeyCode('KeyR', 'ru')).toBe('к');
    expect(letterFromKeyCode('BracketLeft', 'ru')).toBe('х');
    expect(letterFromKeyCode('KeyM', 'ru')).toBeNull(); // ь — not pickable
    expect(letterFromKeyCode('KeyR', 'en')).toBe('r');
    expect(letterFromKeyCode('Comma', 'en')).toBeNull();
  });
});

describe('russian mode — game', () => {
  const RU = new Set(['кот', 'тигр', 'рыба', 'лошадь', 'дом', 'чай', 'арбуз', 'ежик', 'капуста']);
  const dict = (w: string, lang: string) => (lang === 'ru' ? RU.has(w) : WORDS.has(w));

  function ru() {
    const g = new Game(dict);
    g.join(A);
    g.join(B);
    expect(g.setLang('a', 'ru')).toBe(true);
    g.start('a', 0, noShuffle);
    return g;
  }

  it('language is chosen in the lobby only', () => {
    const g = new Game(dict);
    g.join(A);
    g.join(B);
    expect(g.setLang('a', 'de')).toBe(false);
    expect(g.settings.lang).toBe('en');
    g.setLang('a', 'ru');
    g.start('a', 0);
    expect(g.setLang('a', 'en')).toBe(false);
    expect(g.snapshot(0).settings.lang).toBe('ru');
  });

  it('a Latin key picks the Russian letter in the same place (z → я)', () => {
    const g = ru();
    expect(g.pick('a', 'z', 0)).toBe(true);
    expect(g.phase).toBe('typing');
    expect(g.letter).toBe('я');
  });

  it('soft sign, й, ё, wrong language', () => {
    const g = ru();
    expect(g.pick('a', 'ь', 0)).toBe(false);
    expect(g.pick('a', 'л', 0)).toBe(true);
    expect(g.submit('b', 'apple', 1)).toEqual({ ok: false, error: 'wrong_letter' }); // "apple" → "фззду" on ru layout
    expect(g.submit('b', 'лошадь', 1)).toEqual({ ok: true });
    expect(g.letter).toBe('д');
    expect(g.submit('a', 'дом', 2)).toEqual({ ok: true });
    g.used.add('мак');
    g.letter = 'ч';
    g.turnId = 'b';
    expect(g.submit('b', 'чай', 3)).toEqual({ ok: true });
    expect(g.letter).toBe('а'); // й skipped
    expect(g.submit('a', 'арбуз', 4)).toEqual({ ok: true });
    g.letter = 'е';
    expect(g.submit('b', 'ёжик', 5)).toEqual({ ok: true }); // ё typed, stored as е
    expect(g.used.has('ежик')).toBe(true);
  });

  it('English words are not Russian words', () => {
    const g = ru();
    g.pick('a', 'к', 0);
    expect(g.submit('b', 'капут', 1)).toEqual({ ok: false, error: 'not_word' });
    expect(g.submit('b', 'кот', 1)).toEqual({ ok: true });
  });

  it('auto-picked letter is Russian', () => {
    const g = ru();
    g.tick(PICK_MS);
    expect(g.letter).toMatch(/^[а-я]$/);
  });
});
