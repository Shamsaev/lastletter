import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Game, type PlayerInfo } from '../shared/game.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { normalizeInput, MAX_WORD } from '../shared/text.js';
import { loadDictionary } from './dictionary.js';
import { Stats, type Location, type MessageBody } from './stats.js';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? '';
const PROD = process.env.NODE_ENV === 'production';
/** Guests = players without Discord auth (browser testing). Off in production unless asked. */
const ALLOW_GUESTS = process.env.ALLOW_GUESTS ? process.env.ALLOW_GUESTS === '1' : !PROD;
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? 'dist');
/** Bot token: posts results to the voice channel's text chat. Without it stats are only stored. */
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const DISCORD_API = process.env.DISCORD_API ?? 'https://discord.com/api/v10';
const STATS_FILE = process.env.STATS_FILE ?? 'data/stats.json';
const TICK_MS = 200;
const EMPTY_ROOM_TTL_MS = 60_000;
const WORD_COOLDOWN_MS = 250;

const dictionary = loadDictionary();
const isWord = (w: string) => dictionary.has(w);

async function postToChannel(channelId: string, body: MessageBody) {
  if (!BOT_TOKEN) return;
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn(`[stats] Discord ${res.status} for channel ${channelId}: ${await res.text()}`);
}

const stats = new Stats(STATS_FILE, postToChannel, process.env.REPORT_TZ ?? 'Europe/Moscow', process.env.REPORT_TIME ?? '23:59');

// ---------------- rooms ----------------

interface Conn {
  ws: WebSocket;
  user: PlayerInfo;
  room: Room;
  lastWordAt: number;
  alive: boolean;
}

interface Room {
  id: string;
  game: Game;
  conns: Set<Conn>;
  emptySince: number | null;
  /** Voice channel the Activity runs in — where results are posted. */
  location: Location | null;
  reportedGame: number;
}

const rooms = new Map<string, Room>();

function getRoom(id: string): Room {
  let r = rooms.get(id);
  if (!r) {
    r = { id, game: new Game(isWord, Number(process.env.RECONNECT_GRACE_MS ?? 20_000)), conns: new Set(), emptySince: null, location: null, reportedGame: 0 };
    rooms.set(id, r);
  }
  return r;
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Room) {
  const msg = JSON.stringify({ t: 'state', s: room.game.snapshot(Date.now()) } satisfies ServerMsg);
  for (const c of room.conns) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  maybeReport(room);
}

/** Each finished game is reported exactly once. */
function maybeReport(room: Room) {
  const result = room.game.result();
  if (!result || room.reportedGame === room.game.gameNo) return;
  room.reportedGame = room.game.gameNo;
  if (room.location) void stats.recordGame(room.location, result);
}

/**
 * Where is this Activity running? Ask Discord (trusted) and fall back to what the client says.
 * https://discord.com/developers/docs/resources/application#get-application-activity-instance
 */
async function resolveLocation(room: Room, instanceId: string, hint: { channelId?: string; guildId?: string }) {
  if (room.location) return;
  if (BOT_TOKEN && CLIENT_ID) {
    try {
      const res = await fetch(`${DISCORD_API}/applications/${CLIENT_ID}/activity-instances/${encodeURIComponent(instanceId)}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` },
      });
      if (res.ok) {
        const inst = (await res.json()) as { location?: { channel_id?: string; guild_id?: string | null } };
        const loc = inst.location;
        if (loc?.channel_id && loc.guild_id) {
          room.location = { channelId: loc.channel_id, guildId: loc.guild_id };
          return;
        }
      }
    } catch {
      /* fall through */
    }
  }
  const ok = (v?: string) => typeof v === 'string' && /^\d{5,25}$/.test(v);
  if (ok(hint.channelId) && ok(hint.guildId)) room.location = { channelId: hint.channelId!, guildId: hint.guildId! };
}

function userConnected(room: Room, id: string) {
  for (const c of room.conns) if (c.user.id === id) return true;
  return false;
}

// ---------------- auth ----------------

const tokenCache = new Map<string, { user: PlayerInfo; at: number }>();

async function userFromToken(token: string): Promise<PlayerInfo | null> {
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.user;
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  const user: PlayerInfo = {
    id: u.id,
    name: (u.global_name || u.username).slice(0, 32),
    // Served by our own /avatars proxy (see handleHttp) — no extra URL mapping needed in Discord.
    avatar: u.avatar ? `/avatars/${u.id}/${u.avatar}.png` : null,
  };
  tokenCache.set(token, { user, at: Date.now() });
  return user;
}

async function exchangeCode(code: string): Promise<string | null> {
  const res = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

// ---------------- http ----------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('too big');
  }
  return body;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');

  if (url.pathname === '/api/token' && req.method === 'POST') {
    try {
      const { code } = JSON.parse(await readBody(req)) as { code?: string };
      const token = code ? await exchangeCode(code) : null;
      res.writeHead(token ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(token ? { access_token: token } : { error: 'exchange_failed' }));
    } catch {
      res.writeHead(400).end();
    }
    return;
  }

  // Avatar proxy: the Activity iframe can only reach our own origin, so we fetch Discord's CDN for it.
  const av = url.pathname.match(/^\/avatars\/(\d{5,25})\/((?:a_)?[0-9a-f]{32})\.png$/);
  if (av) {
    try {
      const r = await fetch(`https://cdn.discordapp.com/avatars/${av[1]}/${av[2]}.png?size=128`);
      if (!r.ok) throw 0;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }

  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clientId: CLIENT_ID }));
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, words: dictionary.size }));
    return;
  }

  // Static files (production build). Unknown paths fall back to index.html.
  const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) return void res.writeHead(403).end();
  try {
    if (!(await stat(file)).isFile()) throw 0;
  } catch {
    file = join(STATIC_DIR, 'index.html');
  }
  try {
    const data = await readFile(file);
    const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found. Run `npm run build` first.');
  }
}

// ---------------- websocket ----------------

const server = createServer((req, res) => void handleHttp(req, res));
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  let conn: Conn | null = null;
  let helloPending = false;

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!conn) {
      if (msg.t !== 'hello' || helloPending) return;
      helloPending = true;
      const roomId = String(msg.room ?? '').slice(0, 100);
      let user: PlayerInfo | null = null;
      if (msg.accessToken) user = await userFromToken(msg.accessToken).catch(() => null);
      else if (ALLOW_GUESTS && msg.guest?.id) {
        user = {
          id: 'guest:' + String(msg.guest.id).slice(0, 40),
          name: String(msg.guest.name || 'Guest').slice(0, 24),
          avatar: null,
        };
      }
      if (ws.readyState !== ws.OPEN) return;
      if (!roomId || !user) {
        send(ws, { t: 'fatal', reason: user ? 'bad_hello' : 'auth' });
        ws.close();
        return;
      }
      // Website rooms and Discord Activity rooms never mix.
      const viaDiscord = !!msg.accessToken;
      const room = getRoom((viaDiscord ? 'dc:' : 'web:') + roomId);
      // Only Discord players (or tests) may tell us which channel to post stats to.
      if (viaDiscord || !PROD) void resolveLocation(room, roomId, { channelId: msg.channelId, guildId: msg.guildId });
      conn = { ws, user, room, lastWordAt: 0, alive: true };
      room.conns.add(conn);
      room.emptySince = null;
      room.game.join(user);
      send(ws, { t: 'welcome', you: user.id });
      broadcast(room);
      return;
    }

    const { game } = conn.room;
    const me = conn.user.id;
    const now = Date.now();
    let changed = false;

    switch (msg.t) {
      case 'start':
        changed = game.start(me, now);
        break;
      case 'settings':
        changed = game.setTurnSeconds(me, Number(msg.turnSeconds));
        break;
      case 'lobby':
        changed = game.toLobby(me);
        break;
      case 'pick':
        changed = game.pick(me, String(msg.letter ?? ''), now);
        break;
      case 'word': {
        const text = String(msg.text ?? '').slice(0, 64);
        if (now - conn.lastWordAt < WORD_COOLDOWN_MS) {
          send(ws, { t: 'reject', error: 'slow_down', word: normalizeInput(text) });
          break;
        }
        conn.lastWordAt = now;
        const r = game.submit(me, text, now);
        if (r.ok) changed = true;
        else send(ws, { t: 'reject', error: r.error, word: normalizeInput(text) });
        break;
      }
      case 'typing': {
        if (game.phase !== 'typing' || game.turnId !== me) break;
        const text = normalizeInput(String(msg.text ?? '')).slice(0, MAX_WORD);
        const out = JSON.stringify({ t: 'typing', by: me, text } satisfies ServerMsg);
        for (const c of conn.room.conns) if (c.user.id !== me && c.ws.readyState === c.ws.OPEN) c.ws.send(out);
        break;
      }
    }
    if (changed) broadcast(conn.room);
  });

  ws.on('pong', () => {
    if (conn) conn.alive = true;
  });

  ws.on('close', () => {
    if (!conn) return;
    const { room, user } = conn;
    room.conns.delete(conn);
    if (!userConnected(room, user.id)) {
      room.game.leave(user.id, Date.now());
      broadcast(room);
    }
    if (room.conns.size === 0) room.emptySince = Date.now();
  });
});

// Game clock + room GC.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.game.tick(now)) broadcast(room);
    if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(room.id);
  }
}, TICK_MS);

// Daily all-time summary to every voice channel that played today.
setInterval(() => void stats.dailyCheck(), 60_000);
setTimeout(() => void stats.dailyCheck(), 5_000);

// Drop dead sockets (closed Discord iframes don't always close cleanly).
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}, 15_000);

server.listen(PORT, () => {
  console.log(
    `[last-letter] :${PORT}  words=${dictionary.size}  guests=${ALLOW_GUESTS ? 'on' : 'off'}  discord=${CLIENT_ID ? 'configured' : 'NOT configured'}  bot=${BOT_TOKEN ? 'on' : 'off'}`,
  );
});
