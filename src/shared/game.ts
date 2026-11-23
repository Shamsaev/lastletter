// Pure game logic: no timers, no sockets. Time (`now`) and randomness (`rng`) come from outside,
// which keeps every rule unit-testable and the server a thin wrapper.

import { EASY_LETTERS, LANGS, PICKABLE, chainLetter, normalizeInput, quickCheck, type Lang, type WordError } from './text.js';

export const MAX_HP = 3;
export const PICK_MS = 10_000;
export const RECONNECT_GRACE_MS = 20_000;
export const TURN_OPTIONS = [10, 15, 20] as const;
export type TurnSeconds = (typeof TURN_OPTIONS)[number];

export type Phase = 'lobby' | 'picking' | 'typing' | 'over';

export interface PlayerInfo {
  id: string;
  name: string;
  avatar: string | null;
}

export interface Player extends PlayerInfo {
  hp: number;
  connected: boolean;
  /** Finishing place, set when eliminated (and 1 for the winner). */
  place: number | null;
  /** Accepted words this game. */
  words: number;
}

export interface ChainEntry {
  word: string;
  by: string;
  /** Round number: a new round starts every time someone picks a letter. */
  round: number;
}

export type GameEvent =
  | { kind: 'start' }
  | { kind: 'picked'; by: string; letter: string; auto: boolean }
  | { kind: 'timeout'; by: string; hp: number }
  | { kind: 'out'; by: string; reason: 'hp' | 'left' | 'surrender' }
  | { kind: 'win'; by: string | null };

export interface Settings {
  turnSeconds: TurnSeconds;
  /** Language of the words: English (any word) or Russian (nouns). */
  lang: Lang;
}

export interface Snapshot {
  phase: Phase;
  settings: Settings;
  members: PlayerInfo[];
  players: Player[];
  /** Picker in `picking`, writer in `typing`. */
  turnId: string | null;
  /** In `picking`: who will answer the chosen letter. */
  nextId: string | null;
  letter: string | null;
  round: number;
  used: string[];
  chain: ChainEntry[];
  deadline: number | null;
  /** Full length of the current countdown, for drawing the bar. */
  turnMs: number;
  winnerId: string | null;
  events: { seq: number; e: GameEvent }[];
  now: number;
}

export type SubmitResult = { ok: true } | { ok: false; error: WordError | 'not_your_turn' };

type Rng = () => number;

/** Everything the stats reporter needs once a game is over. */
export interface GameResult {
  winnerId: string | null;
  /** Sorted by place (1 = winner). */
  players: { id: string; name: string; place: number; words: number }[];
  totalWords: number;
  longest: ChainEntry | null;
}

export class Game {
  phase: Phase = 'lobby';
  settings: Settings = { turnSeconds: 15, lang: 'en' };
  members = new Map<string, PlayerInfo>();
  players: Player[] = [];
  turnId: string | null = null;
  letter: string | null = null;
  used = new Set<string>();
  chain: ChainEntry[] = [];
  deadline: number | null = null;
  turnMs = 0;
  winnerId: string | null = null;
  round = 0;
  /** Increments on every start — lets the server report each finished game exactly once. */
  gameNo = 0;
  private disconnectedAt = new Map<string, number>();
  private events: { seq: number; e: GameEvent }[] = [];
  private seq = 0;

  constructor(
    private isWord: (w: string, lang: Lang) => boolean,
    public graceMs = RECONNECT_GRACE_MS,
  ) {}

  // ---------- membership ----------

  join(info: PlayerInfo): void {
    this.members.set(info.id, info);
    const p = this.player(info.id);
    if (p) {
      Object.assign(p, { name: info.name, avatar: info.avatar, connected: true });
      this.disconnectedAt.delete(info.id);
    }
  }

  leave(id: string, now: number): void {
    this.members.delete(id);
    const p = this.player(id);
    if (!p) return;
    if (this.inGame() && p.hp > 0) {
      p.connected = false;
      this.disconnectedAt.set(id, now);
    } else if (!this.inGame()) {
      p.connected = false;
    }
  }

  isEmpty(): boolean {
    return this.members.size === 0;
  }

  // ---------- lobby ----------

  setTurnSeconds(byId: string, s: number): boolean {
    if (this.inGame() || !this.members.has(byId)) return false;
    if (!(TURN_OPTIONS as readonly number[]).includes(s)) return false;
    this.settings.turnSeconds = s as TurnSeconds;
    return true;
  }

  /** Word language is chosen in the lobby (or on the results screen before playing again). */
  setLang(byId: string, lang: string): boolean {
    if (this.inGame() || !this.members.has(byId)) return false;
    if (!(LANGS as readonly string[]).includes(lang)) return false;
    this.settings.lang = lang as Lang;
    return true;
  }

  canStart(): boolean {
    return !this.inGame() && this.members.size >= 2;
  }

  start(byId: string, now: number, rng: Rng = Math.random): boolean {
    if (!this.canStart() || !this.members.has(byId)) return false;
    const order = shuffle([...this.members.values()], rng);
    this.players = order.map((m) => ({ ...m, hp: MAX_HP, connected: true, place: null, words: 0 }));
    this.gameNo += 1;
    this.used.clear();
    this.chain = [];
    this.winnerId = null;
    this.letter = null;
    this.disconnectedAt.clear();
    this.events = [];
    this.emit({ kind: 'start' });
    this.beginPicking(this.players[0].id, now);
    return true;
  }

  toLobby(byId: string): boolean {
    if (this.phase !== 'over' || !this.members.has(byId)) return false;
    this.phase = 'lobby';
    this.players = [];
    this.events = [];
    return true;
  }

  // ---------- turns ----------

  pick(byId: string, letter: string, now: number): boolean {
    if (this.phase !== 'picking' || this.turnId !== byId) return false;
    const l = normalizeInput(letter, this.settings.lang);
    if (l.length !== 1 || !PICKABLE[this.settings.lang].includes(l)) return false;
    this.emit({ kind: 'picked', by: byId, letter: l, auto: false });
    this.beginTyping(l, this.nextAlive(byId)!, now);
    return true;
  }

  submit(byId: string, raw: string, now: number): SubmitResult {
    if (this.phase !== 'typing' || this.turnId !== byId) return { ok: false, error: 'not_your_turn' };
    const { lang } = this.settings;
    const word = normalizeInput(raw, lang);
    const err = quickCheck(word, this.letter!, (w) => this.used.has(w)) ?? (this.isWord(word, lang) ? null : 'not_word');
    if (err) return { ok: false, error: err };
    this.used.add(word);
    this.chain.push({ word, by: byId, round: this.round });
    this.player(byId)!.words += 1;
    this.beginTyping(chainLetter(word, lang), this.nextAlive(byId)!, now);
    return { ok: true };
  }

  /**
   * Give up right away: out of this game, stays in the room as a spectator.
   * If it was their turn, the next player starts a new round by picking a letter.
   */
  surrender(byId: string, now: number): boolean {
    if (!this.inGame()) return false;
    const p = this.player(byId);
    if (!p || p.hp <= 0) return false;
    const hadTurn = this.turnId === byId;
    this.disconnectedAt.delete(byId);
    this.eliminate(p, 'surrender');
    if (this.checkWin()) return true;
    if (hadTurn) this.beginPicking(this.nextAlive(byId)!, now);
    return true;
  }

  /** Advances time: reconnect grace, pick timeouts, turn timeouts. Returns true if state changed. */
  tick(now: number, rng: Rng = Math.random): boolean {
    if (!this.inGame()) return false;
    let changed = false;

    for (const [id, at] of this.disconnectedAt) {
      if (now - at < this.graceMs) continue;
      this.disconnectedAt.delete(id);
      const p = this.player(id)!;
      if (p.hp <= 0) continue;
      const hadTurn = this.turnId === id;
      this.eliminate(p, 'left');
      changed = true;
      if (this.checkWin()) return true;
      // Whoever was waiting on the leaver: next alive player starts a fresh round.
      if (hadTurn) this.beginPicking(this.nextAlive(id)!, now);
    }

    if (this.deadline !== null && now >= this.deadline) {
      changed = true;
      const id = this.turnId!;
      if (this.phase === 'picking') {
        const easy = EASY_LETTERS[this.settings.lang];
        const letter = easy[Math.floor(rng() * easy.length)];
        this.emit({ kind: 'picked', by: id, letter, auto: true });
        this.beginTyping(letter, this.nextAlive(id)!, now);
      } else {
        const p = this.player(id)!;
        p.hp -= 1;
        this.emit({ kind: 'timeout', by: id, hp: p.hp });
        if (p.hp <= 0) {
          this.eliminate(p, 'hp');
          if (this.checkWin()) return true;
          this.beginPicking(this.nextAlive(id)!, now);
        } else {
          this.beginPicking(id, now);
        }
      }
    }
    return changed;
  }

  // ---------- view ----------

  snapshot(now: number): Snapshot {
    return {
      phase: this.phase,
      settings: { ...this.settings },
      members: [...this.members.values()],
      players: this.players.map((p) => ({ ...p })),
      turnId: this.turnId,
      nextId: this.phase === 'picking' ? this.nextId() : null,
      letter: this.letter,
      round: this.round,
      used: [...this.used],
      chain: this.chain.slice(-20),
      deadline: this.deadline,
      turnMs: this.turnMs,
      winnerId: this.winnerId,
      events: this.events.slice(-5),
      now,
    };
  }

  result(): GameResult | null {
    if (this.phase !== 'over') return null;
    const players = [...this.players]
      .map((p) => ({ id: p.id, name: p.name, place: p.place ?? this.players.length, words: p.words }))
      .sort((a, b) => a.place - b.place);
    const longest = this.chain.reduce<ChainEntry | null>((a, c) => (!a || c.word.length > a.word.length ? c : a), null);
    return { winnerId: this.winnerId, players, totalWords: this.chain.length, longest };
  }

  alive(): Player[] {
    return this.players.filter((p) => p.hp > 0);
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  // ---------- internals ----------

  private inGame(): boolean {
    return this.phase === 'picking' || this.phase === 'typing';
  }

  private nextId(): string | null {
    return this.turnId ? this.nextAlive(this.turnId) : null;
  }

  /** Next alive player clockwise after `id` (works for already-eliminated `id` too). */
  nextAlive(id: string): string | null {
    const i = this.players.findIndex((p) => p.id === id);
    for (let k = 1; k <= this.players.length; k++) {
      const p = this.players[(i + k) % this.players.length];
      if (p.hp > 0 && p.id !== id) return p.id;
    }
    return null;
  }

  private beginPicking(id: string, now: number): void {
    this.phase = 'picking';
    this.round += 1;
    this.turnId = id;
    this.letter = null;
    this.turnMs = PICK_MS;
    this.deadline = now + PICK_MS;
  }

  private beginTyping(letter: string, id: string, now: number): void {
    this.phase = 'typing';
    this.letter = letter;
    this.turnId = id;
    this.turnMs = this.settings.turnSeconds * 1000;
    this.deadline = now + this.turnMs;
  }

  private eliminate(p: Player, reason: 'hp' | 'left' | 'surrender'): void {
    p.hp = 0;
    p.place = this.alive().length + 1;
    this.emit({ kind: 'out', by: p.id, reason });
  }

  private checkWin(): boolean {
    const alive = this.alive();
    if (alive.length > 1) return false;
    this.phase = 'over';
    this.winnerId = alive[0]?.id ?? null;
    if (alive[0]) alive[0].place = 1;
    this.turnId = null;
    this.deadline = null;
    this.letter = null;
    this.emit({ kind: 'win', by: this.winnerId });
    return true;
  }

  private emit(e: GameEvent): void {
    this.events.push({ seq: ++this.seq, e });
    if (this.events.length > 20) this.events.shift();
  }
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

