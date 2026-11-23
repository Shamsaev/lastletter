import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameResult } from '../src/shared/game';
import { Stats, gameMessage, type MessageBody } from '../src/server/stats';

const LOC = { guildId: '11111', channelId: '22222' };
const result = (winner: string, loser: string, words = [3, 1]): GameResult => ({
  winnerId: winner,
  players: [
    { id: winner, name: winner.toUpperCase(), place: 1, words: words[0] },
    { id: loser, name: loser.toUpperCase(), place: 2, words: words[1] },
  ],
  totalWords: words[0] + words[1],
  longest: { word: 'elephant', by: winner, round: 1 },
});

// Moscow is UTC+3: 20:00Z = 23:00 MSK, 21:00Z = 00:00 next day MSK.
const at = (iso: string) => new Date(iso);

function make(file: string | null = null) {
  const posts: { channel: string; body: MessageBody }[] = [];
  const stats = new Stats(file, async (channel, body) => void posts.push({ channel, body }), 'Europe/Moscow', '23:59');
  return { stats, posts };
}

describe('stats', () => {
  it('posts a result after each game: places, words, longest; mentions never ping', async () => {
    const { stats, posts } = make();
    await stats.recordGame(LOC, result('333333', '444444', [7, 2]), at('2026-11-23T12:00:00Z'));
    expect(posts).toHaveLength(1);
    const { channel, body } = posts[0];
    expect(channel).toBe('22222');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const e = body.embeds![0];
    expect(e.title).toContain('333333'.toUpperCase());
    expect(e.description).toBe('🥇 <@333333> — 7 слов\n🥈 <@444444> — 2 слова');
    expect(e.footer!.text).toBe('Всего 9 слов · самое длинное: ELEPHANT');
  });

  it('accumulates all-time stats per server', async () => {
    const { stats } = make();
    const day = at('2026-11-23T12:00:00Z');
    await stats.recordGame(LOC, result('a1111', 'b2222'), day);
    await stats.recordGame(LOC, result('a1111', 'b2222'), day);
    await stats.recordGame(LOC, result('b2222', 'a1111'), day);
    const g = stats.data.guilds['11111'];
    expect(g.games).toBe(3);
    expect(g.players['a1111']).toMatchObject({ games: 3, wins: 2, words: 7 });
    expect(g.players['b2222']).toMatchObject({ games: 3, wins: 1, words: 5 });
    expect(stats.data.channels['22222'].gamesThatDay).toBe(3);
  });

  it('daily summary goes out once, after report time, only to channels that played today', async () => {
    const { stats, posts } = make();
    await stats.recordGame(LOC, result('a1111', 'b2222'), at('2026-11-23T12:00:00Z'));
    posts.length = 0;

    expect(await stats.dailyCheck(at('2026-11-23T20:00:00Z'))).toEqual([]); // 23:00 MSK — too early
    expect(await stats.dailyCheck(at('2026-11-23T20:59:00Z'))).toEqual(['22222']); // 23:59 MSK
    expect(posts[0].body.embeds![0].title).toContain('за всё время');
    expect(posts[0].body.embeds![0].description).toContain('<@a1111> — 🏆 1 · 1 игра (100%) · 3 слова');
    expect(posts[0].body.embeds![0].footer!.text).toContain('Сегодня: 1 партия');

    expect(await stats.dailyCheck(at('2026-11-23T20:59:30Z'))).toEqual([]); // not twice
    expect(await stats.dailyCheck(at('2026-11-24T20:59:00Z'))).toEqual([]); // nobody played next day
  });

  it('catches up a missed summary (server was down at 23:59)', async () => {
    const { stats, posts } = make();
    await stats.recordGame(LOC, result('a1111', 'b2222'), at('2026-11-23T12:00:00Z'));
    posts.length = 0;
    // next day, before report time: yesterday is still sent
    expect(await stats.dailyCheck(at('2026-11-24T06:00:00Z'))).toEqual(['22222']);
  });

  it('a new day game flushes the unsent summary of the previous day first', async () => {
    const { stats, posts } = make();
    await stats.recordGame(LOC, result('a1111', 'b2222'), at('2026-11-23T12:00:00Z'));
    posts.length = 0;
    await stats.recordGame(LOC, result('a1111', 'b2222'), at('2026-11-24T12:00:00Z'));
    expect(posts.map((p) => p.body.embeds![0].title)).toEqual([
      '📊 Last Letter — статистика за всё время',
      expect.stringContaining('Победа'),
    ]);
    expect(stats.data.channels['22222'].gamesThatDay).toBe(1);
  });

  it('survives restarts (file storage)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'll-')), 'stats.json');
    await make(file).stats.recordGame(LOC, result('a1111', 'b2222'), at('2026-11-23T12:00:00Z'));
    const again = make(file).stats;
    expect(again.data.guilds['11111'].games).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).guilds['11111'].players.a1111.wins).toBe(1);
  });

  it('game without a winner still lists places', () => {
    const r = { ...result('a1111', 'b2222'), winnerId: null };
    expect(gameMessage(r).embeds![0].title).toBe('Партия окончена');
  });
});
