// Integration: real server process, real WebSockets, real dictionary.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '../src/shared/protocol';
import type { Snapshot } from '../src/shared/game';

const PORT = 3900 + Math.floor(Math.random() * 90);
const FAKE_DISCORD_PORT = PORT + 100;
let proc: ChildProcess;
let fake: Server;
/** Requests the game server made to the (fake) Discord API. */
const discordCalls: { method: string; url: string; body: any }[] = [];

beforeAll(async () => {
  fake = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    discordCalls.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
    if (req.url!.includes('/activity-instances/')) return void res.writeHead(404).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  }).listen(FAKE_DISCORD_PORT);

  proc = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ALLOW_GUESTS: '1',
      NODE_ENV: 'test',
      DISCORD_API: `http://localhost:${FAKE_DISCORD_PORT}`,
      DISCORD_BOT_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '999999',
      RECONNECT_GRACE_MS: '1500',
      STATS_FILE: join(mkdtempSync(join(tmpdir(), 'll-')), 'stats.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('server did not start')), 15_000);
    proc.stdout!.on('data', (d) => String(d).includes('[last-letter]') && (clearTimeout(t), ok()));
  });
}, 20_000);

afterAll(() => {
  proc?.kill();
  fake?.close();
});

class Client {
  ws: WebSocket;
  state: Snapshot | null = null;
  msgs: ServerMsg[] = [];
  private waiters: Array<() => void> = [];

  constructor(public id: string, room: string, loc: { channelId?: string; guildId?: string } = {}) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('open', () => this.send({ t: 'hello', room, guest: { id, name: id.toUpperCase() }, ...loc }));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      this.msgs.push(m);
      if (m.t === 'state') this.state = m.s;
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async until(pred: (c: Client) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!pred(this)) {
      if (Date.now() > end) throw new Error(`timeout waiting on ${this.id}: ${JSON.stringify(this.state)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  get me() {
    return 'guest:' + this.id;
  }
}

describe('server', () => {
  it('serves health with the dictionary loaded', async () => {
    const r = await fetch(`http://localhost:${PORT}/api/health`);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.words).toBeGreaterThan(200_000);
  });

  it('two players: lobby → pick → words → rejects → typing relay', async () => {
    const room = 'r' + Math.random();
    const a = new Client('a', room);
    const b = new Client('b', room);
    await a.until((c) => c.state?.members.length === 2);
    a.send({ t: 'start' });
    await a.until((c) => c.state?.phase === 'picking');
    await b.until((c) => c.state?.phase === 'picking');

    const picker = [a, b].find((c) => c.state!.turnId === c.me)!;
    const writer = picker === a ? b : a;
    picker.send({ t: 'pick', letter: 'c' });
    await writer.until((c) => c.state?.phase === 'typing' && c.state.turnId === writer.me);
    expect(writer.state!.letter).toBe('c');

    // live typing goes to the other player, normalized
    writer.send({ t: 'typing', text: 'CA' });
    await picker.until((c) => c.msgs.some((m) => m.t === 'typing' && m.text === 'ca'));

    writer.send({ t: 'word', text: 'cxzqv' });
    await writer.until((c) => c.msgs.some((m) => m.t === 'reject' && m.error === 'not_word'));
    await new Promise((r) => setTimeout(r, 300)); // cooldown
    writer.send({ t: 'word', text: 'Cat' });
    await picker.until((c) => c.state?.turnId === picker.me && c.state.letter === 't');
    expect(picker.state!.used).toEqual(['cat']);

    picker.send({ t: 'word', text: 'ещзшс' }); // "topic" typed on Russian layout
    await writer.until((c) => c.state?.letter === 'c' && c.state.used.includes('topic'));

    // anti-spam
    writer.send({ t: 'word', text: 'cat' });
    writer.send({ t: 'word', text: 'cat' });
    await writer.until((c) => c.msgs.some((m) => m.t === 'reject' && m.error === 'slow_down'));
    a.ws.close();
    b.ws.close();
  });

  it('late joiner spectates; leaver eventually loses (grace) — leaving keeps seat until grace', async () => {
    const room = 'r' + Math.random();
    const a = new Client('a', room);
    const b = new Client('b', room);
    await a.until((c) => c.state?.members.length === 2);
    a.send({ t: 'start' });
    await a.until((c) => c.state?.phase === 'picking');
    const c = new Client('c', room);
    await c.until((x) => x.state?.members.length === 3);
    expect(c.state!.players.map((p) => p.id)).not.toContain(c.me);

    b.ws.close();
    await a.until((x) => x.state?.players.find((p) => p.id === b.me)?.connected === false);
    // reconnect with same id → seat restored
    const b2 = new Client('b', room);
    await b2.until((x) => x.state?.players.find((p) => p.id === b2.me)?.connected === true);
    expect(b2.state!.players.find((p) => p.id === b2.me)!.hp).toBe(3);
    [a, b2, c].forEach((x) => x.ws.close());
  });

  it('rooms are isolated', async () => {
    const a = new Client('a', 'room-x' + Math.random());
    const b = new Client('b', 'room-y' + Math.random());
    await a.until((c) => !!c.state);
    await b.until((c) => !!c.state);
    expect(a.state!.members).toHaveLength(1);
    expect(b.state!.members).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });

  it('rejects unauthenticated hello when there is no token or guest', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const msg = await new Promise<ServerMsg>((ok) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', room: 'z' })));
      ws.on('message', (raw) => ok(JSON.parse(String(raw))));
    });
    expect(msg).toEqual({ t: 'fatal', reason: 'auth' });
  });

  it('finished game is posted once to the voice channel text chat via the bot', async () => {
    const room = 'r' + Math.random();
    const loc = { channelId: '700000000000000001', guildId: '800000000000000001' };
    const a = new Client('a', room, loc);
    const b = new Client('b', room, loc);
    await a.until((c) => c.state?.members.length === 2);
    a.send({ t: 'start' });
    await a.until((c) => c.state?.phase === 'picking');
    b.ws.close(); // b gone longer than grace → a wins
    await a.until((c) => c.state?.phase === 'over', 5000);

    const posted = () => discordCalls.filter((c) => c.url === `/channels/${loc.channelId}/messages`);
    const end = Date.now() + 3000;
    while (!posted().length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(posted()).toHaveLength(1);
    const msg = posted()[0].body;
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.embeds[0].title).toContain('A');
    expect(msg.embeds[0].description).toMatch(/🥇 A — 0 слов\n🥈 B — 0 слов/);
    // the server tried to verify the channel with Discord first
    expect(discordCalls.some((c) => c.url.includes(`/applications/999999/activity-instances/`))).toBe(true);

    // more state broadcasts must not post again
    a.send({ t: 'settings', turnSeconds: 20 });
    await a.until((c) => c.state?.settings.turnSeconds === 20);
    await new Promise((r) => setTimeout(r, 300));
    expect(posted()).toHaveLength(1);
    a.ws.close();
  }, 15_000);

  it('surrender over the socket ends a 2-player game at once', async () => {
    const room = 'r' + Math.random();
    const a = new Client('a', room);
    const b = new Client('b', room);
    await a.until((c) => c.state?.members.length === 2);
    a.send({ t: 'start' });
    await a.until((c) => c.state?.phase === 'picking');
    b.send({ t: 'surrender' });
    await a.until((c) => c.state?.phase === 'over');
    expect(a.state!.winnerId).toBe(a.me);
    a.ws.close();
    b.ws.close();
  });
});
