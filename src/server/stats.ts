// Persistent stats + messages to the voice channel's text chat.
// No stats are shown inside the Activity: after each game a short result is posted,
// and once a day an all-time leaderboard goes to every voice channel that played that day.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameResult } from '../shared/game.js';

export interface Location {
  guildId: string;
  channelId: string;
}

interface PlayerStats {
  name: string;
  games: number;
  wins: number;
  words: number;
}

interface GuildStats {
  games: number;
  players: Record<string, PlayerStats>;
  longest: { word: string; by: string } | null;
}

interface ChannelInfo {
  guildId: string;
  /** Local date (YYYY-MM-DD in REPORT_TZ) of the last game in this channel. */
  lastPlayed: string;
  gamesThatDay: number;
  /** Date whose games were already summarized. */
  lastReported: string | null;
}

export interface StatsData {
  guilds: Record<string, GuildStats>;
  channels: Record<string, ChannelInfo>;
}

export interface MessageBody {
  content?: string;
  embeds?: { title?: string; description: string; color?: number; footer?: { text: string } }[];
  allowed_mentions: { parse: string[] };
}

export type Poster = (channelId: string, body: MessageBody) => Promise<void>;

const ACCENT = 0xffd447;
const MEDALS = ['🥇', '🥈', '🥉'];

export class Stats {
  data: StatsData;

  constructor(
    private file: string | null,
    private post: Poster,
    private tz = 'Europe/Moscow',
    private reportAt = '23:59',
  ) {
    this.data = { guilds: {}, channels: {} };
    if (file) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* first run */
      }
    }
  }

  /** Called once per finished game. Updates stats and posts the game summary. */
  async recordGame(loc: Location, result: GameResult, now = new Date()): Promise<void> {
    const real = result.players;
    if (real.length < 2) return;
    await this.dailyCheck(now); // flush a missed summary of a previous day before overwriting it

    const g =(this.data.guilds[loc.guildId] ??= { games: 0, players: {}, longest: null });
    g.games += 1;
    for (const p of real) {
      const s = (g.players[p.id] ??= { name: p.name, games: 0, wins: 0, words: 0 });
      s.name = p.name;
      s.games += 1;
      s.words += p.words;
      if (p.place === 1) s.wins += 1;
    }
    if (result.longest && (!g.longest || result.longest.word.length > g.longest.word.length)) {
      g.longest = { word: result.longest.word, by: result.longest.by };
    }

    const today = this.localDate(now);
    const ch = this.data.channels[loc.channelId];
    if (ch && ch.lastPlayed === today) ch.gamesThatDay += 1;
    else
      this.data.channels[loc.channelId] = {
        guildId: loc.guildId,
        lastPlayed: today,
        gamesThatDay: 1,
        lastReported: ch?.lastReported ?? null,
      };
    this.save();

    await this.post(loc.channelId, gameMessage(result)).catch((e) => console.warn('[stats] post failed', e));
  }

  /**
   * Run every minute. A channel gets the daily summary when its last game day is finished
   * (report time passed, or the day is already over — covers server restarts).
   */
  async dailyCheck(now = new Date()): Promise<string[]> {
    const today = this.localDate(now);
    const pastReportTime = this.localTime(now) >= this.reportAt;
    const sent: string[] = [];
    for (const [channelId, ch] of Object.entries(this.data.channels)) {
      if (ch.lastReported === ch.lastPlayed) continue;
      if (ch.lastPlayed === today && !pastReportTime) continue;
      const guild = this.data.guilds[ch.guildId];
      ch.lastReported = ch.lastPlayed;
      this.save();
      if (!guild) continue;
      await this.post(channelId, dailyMessage(guild, ch.gamesThatDay)).catch((e) =>
        console.warn('[stats] daily post failed', e),
      );
      sent.push(channelId);
    }
    return sent;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  private localDate(d: Date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.tz }).format(d); // YYYY-MM-DD
  }

  private localTime(d: Date) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  }
}

// ---------------- messages (Russian, mentions never ping) ----------------

const NO_PINGS = { parse: [] as string[] };

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
const words = (n: number) => plural(n, 'слово', 'слова', 'слов');
const who = (id: string, name: string) => (id.startsWith('guest:') ? name : `<@${id}>`);

export function gameMessage(r: GameResult): MessageBody {
  const lines = r.players.map(
    (p) => `${MEDALS[p.place - 1] ?? `\`${p.place}.\``} ${who(p.id, p.name)} — ${words(p.words)}`,
  );
  const winner = r.players.find((p) => p.id === r.winnerId);
  const footer = [`Всего ${words(r.totalWords)}`];
  if (r.longest) footer.push(`самое длинное: ${r.longest.word.toUpperCase()}`);
  return {
    embeds: [
      {
        title: winner ? `🏆 Победа — ${winner.name}` : 'Партия окончена',
        description: lines.join('\n'),
        color: ACCENT,
        footer: { text: footer.join(' · ') },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
}

export function dailyMessage(g: GuildStats, gamesToday: number): MessageBody {
  const rows = Object.entries(g.players)
    .sort(([, a], [, b]) => b.wins - a.wins || b.wins / b.games - a.wins / a.games || b.words - a.words)
    .slice(0, 20)
    .map(([id, s], i) => {
      const rate = Math.round((s.wins / s.games) * 100);
      return `${MEDALS[i] ?? `\`${i + 1}.\``} ${who(id, s.name)} — 🏆 ${s.wins} · ${plural(s.games, 'игра', 'игры', 'игр')} (${rate}%) · ${words(s.words)}`;
    });
  const footer = [`Сегодня: ${plural(gamesToday, 'партия', 'партии', 'партий')}`, `за всё время: ${g.games}`];
  if (g.longest) footer.push(`рекорд: ${g.longest.word.toUpperCase()}`);
  return {
    embeds: [
      {
        title: '📊 Last Letter — статистика за всё время',
        description: rows.join('\n') || 'Пока пусто',
        color: ACCENT,
        footer: { text: footer.join(' · ') },
      },
    ],
    allowed_mentions: NO_PINGS,
  };
}
