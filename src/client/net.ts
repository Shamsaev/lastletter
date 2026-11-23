import { useCallback, useEffect, useRef, useState } from 'react';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { Snapshot } from '../shared/game';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

export const IN_DISCORD = new URLSearchParams(location.search).has('frame_id');

interface Identity {
  room: string;
  channelId?: string;
  guildId?: string;
  accessToken?: string;
  guest?: { id: string; name: string };
}

async function identify(): Promise<Identity> {
  if (IN_DISCORD) {
    // Client ID comes from the server at runtime, so one build works for any app.
    const { clientId } = (await (await fetch('/api/config')).json()) as { clientId: string };
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { access_token } = (await res.json()) as { access_token?: string };
    if (!access_token) throw new Error('token');
    await sdk.commands.authenticate({ access_token });
    return {
      room: sdk.instanceId,
      accessToken: access_token,
      channelId: sdk.channelId ?? undefined,
      guildId: sdk.guildId ?? undefined,
    };
  }

  // Browser mode for local testing: every tab is a separate player.
  // ?room=abc&name=Alice — sessionStorage keeps the same id across reloads of one tab.
  const q = new URLSearchParams(location.search);
  let id = sessionStorage.getItem('ll-guest-id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('ll-guest-id', id);
  }
  return {
    room: q.get('room') ?? 'local',
    channelId: q.get('channel') ?? undefined,
    guildId: q.get('guild') ?? undefined,
    guest: { id, name: q.get('name') ?? `Guest-${id.slice(0, 4)}` },
  };
}

export type Status = 'connecting' | 'online' | 'reconnecting' | 'fatal';

export interface Reject {
  error: Extract<ServerMsg, { t: 'reject' }>['error'];
  word: string;
  at: number;
}

export function useGame() {
  const [status, setStatus] = useState<Status>('connecting');
  const [you, setYou] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<{ by: string; text: string } | null>(null);
  const [reject, setReject] = useState<Reject | null>(null);
  const offset = useRef(0); // serverTime - localTime
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let identity: Identity;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...identity } satisfies ClientMsg));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ServerMsg;
        switch (m.t) {
          case 'welcome':
            retry = 0;
            setYou(m.you);
            setStatus('online');
            break;
          case 'state':
            offset.current = m.s.now - Date.now();
            setSnap(m.s);
            setDraft((d) => (d && d.by === m.s.turnId && m.s.phase === 'typing' ? d : null));
            break;
          case 'typing':
            setDraft({ by: m.by, text: m.text });
            break;
          case 'reject':
            setReject({ error: m.error, word: m.word, at: Date.now() });
            break;
          case 'fatal':
            stopped = true;
            setStatus('fatal');
            break;
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus('reconnecting');
        retry++;
        setTimeout(connect, Math.min(5000, 400 * retry));
      };
    };

    identify()
      .then((id) => {
        identity = id;
        connect();
      })
      .catch((e) => {
        console.error(e);
        setStatus('fatal');
      });

    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  return { status, you, snap, draft, reject, send, serverNow };
}
