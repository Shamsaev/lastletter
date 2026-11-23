import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MAX_HP, TURN_OPTIONS, type Player, type PlayerInfo, type Snapshot } from '../shared/game';
import { LETTERS, normalizeInput, quickCheck, type WordError } from '../shared/text';
import { t } from './i18n';
import {
  IN_DISCORD,
  discordIdentity,
  newRoomCode,
  roomFromUrl,
  saveName,
  savedName,
  useGame,
  webIdentity,
  type Identity,
  type Reject,
} from './net';
import { isMuted, setMuted, sfx } from './sound';

type Send = ReturnType<typeof useGame>['send'];
type ServerNow = () => number;

export function App() {
  return IN_DISCORD ? <Game identify={discordIdentity} web={false} /> : <Website />;
}

// ---------------- website: name → room link ----------------

function Website() {
  const [room, setRoom] = useState(roomFromUrl);
  const [name, setName] = useState(savedName);

  useEffect(() => {
    const onPop = () => setRoom(roomFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (room && name) return <Game key={room} identify={() => webIdentity(room, name)} web />;

  const submit = (n: string) => {
    saveName(n);
    setName(n);
    if (!room) {
      const code = newRoomCode();
      history.pushState(null, '', `/r/${code}`);
      setRoom(code);
    }
  };
  return <Home initialName={name} joining={!!room} onSubmit={submit} />;
}

function Home({ initialName, joining, onSubmit }: { initialName: string; joining: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initialName);
  const clean = name.trim().slice(0, 24);
  const go = () => clean && onSubmit(clean);
  return (
    <div className="app">
      <RulesButton turnSeconds={15} web />
      <div className="screen home">
        <Logo />
        <input
          className="name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder={t.yourName}
          aria-label={t.yourName}
          maxLength={24}
          autoFocus
          autoComplete="nickname"
          spellCheck={false}
        />
        <button className="primary" disabled={!clean} onClick={go}>
          {joining ? t.join : t.createRoom}
        </button>
      </div>
    </div>
  );
}

// ---------------- game ----------------

function Game({ identify, web }: { identify: () => Identity | Promise<Identity>; web: boolean }) {
  const { status, you, snap, draft, reject, send, serverNow } = useGame(identify);
  const toast = useEventToasts(snap, you);

  if (status === 'fatal') return <Center>{t.authFail}</Center>;
  if (!snap || !you) return <Center muted>{t.connecting}</Center>;

  const names = new Map<string, string>();
  for (const m of [...snap.members, ...snap.players]) names.set(m.id, m.name);
  const name = (id: string | null) => (id ? (names.get(id) ?? '?') : '?');

  return (
    <div className="app">
      <RulesButton turnSeconds={snap.settings.turnSeconds} web={web} />
      <MuteButton />
      {status === 'reconnecting' && <div className="banner">{t.reconnecting}</div>}
      {toast && (
        <div className="toast" key={toast.key}>
          {toast.text}
        </div>
      )}

      {snap.phase === 'lobby' && <Lobby snap={snap} you={you} send={send} web={web} />}

      {(snap.phase === 'picking' || snap.phase === 'typing') && (
        <>
          <PlayersBar players={snap.players} turnId={snap.turnId} you={you} />
          <TimerBar snap={snap} serverNow={serverNow} mine={snap.turnId === you} />
          {snap.phase === 'picking' ? (
            <Picking snap={snap} you={you} send={send} name={name} />
          ) : (
            <Typing snap={snap} you={you} send={send} name={name} draft={draft} reject={reject} />
          )}
        </>
      )}

      {snap.phase === 'over' && <Results snap={snap} you={you} send={send} />}
    </div>
  );
}

// ---------------- lobby ----------------

function Lobby({ snap, you, send, web }: { snap: Snapshot; you: string; send: Send; web: boolean }) {
  const enough = snap.members.length >= 2;
  const [copied, setCopied] = useState(false);
  const invite = async () => {
    const url = `${location.origin}/r/${roomFromUrl() ?? ''}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ url, title: 'Last Letter' });
      else await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <div className="screen lobby">
      <Logo />

      <div className="members">
        {snap.members.map((m) => (
          <div className="member" key={m.id}>
            <Avatar p={m} size={56} />
            <span className="member-name">
              {m.name}
              {m.id === you && <em> · {t.you}</em>}
            </span>
          </div>
        ))}
      </div>

      {web && (
        <button className="invite" onClick={invite}>
          {copied ? t.copied : t.invite}
        </button>
      )}

      <div className="setting">
        <span>{t.turnTime}</span>
        <div className="segmented" role="radiogroup">
          {TURN_OPTIONS.map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={snap.settings.turnSeconds === s}
              className={snap.settings.turnSeconds === s ? 'on' : ''}
              onClick={() => send({ t: 'settings', turnSeconds: s })}
            >
              {s}
              {t.sec}
            </button>
          ))}
        </div>
      </div>

      <button className="primary" disabled={!enough} onClick={() => send({ t: 'start' })}>
        {t.start}
      </button>
    </div>
  );
}

function Logo() {
  return (
    <h1 className="logo">
      LAST LETTE<span className="accent">R</span>
    </h1>
  );
}

// ---------------- in game ----------------

function PlayersBar({ players, turnId, you }: { players: Player[]; turnId: string | null; you: string }) {
  return (
    <div className="players">
      {players.map((p) => (
        <div
          key={p.id}
          className={['chip', p.id === turnId && 'active', p.hp <= 0 && 'out', !p.connected && 'offline']
            .filter(Boolean)
            .join(' ')}
        >
          <Avatar p={p} size={44} />
          <span className="chip-name">{p.id === you ? t.you : p.name}</span>
          <Hearts hp={p.hp} />
        </div>
      ))}
    </div>
  );
}

function Hearts({ hp }: { hp: number }) {
  return (
    <span className="hearts" aria-label={`${hp}/${MAX_HP}`}>
      {Array.from({ length: MAX_HP }, (_, i) => (
        <span key={i} className={i < hp ? 'heart' : 'heart lost'}>
          ♥
        </span>
      ))}
    </span>
  );
}

function TimerBar({ snap, serverNow, mine }: { snap: Snapshot; serverNow: ServerNow; mine: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let lastSec = -1;
    const loop = () => {
      const left = Math.max(0, (snap.deadline ?? 0) - serverNow());
      const frac = snap.turnMs ? left / snap.turnMs : 0;
      if (bar.current) {
        bar.current.style.transform = `scaleX(${frac})`;
        bar.current.classList.toggle('low', left < 3000);
      }
      const sec = Math.ceil(left / 1000);
      if (label.current) label.current.textContent = String(sec);
      if (mine && sec !== lastSec && sec > 0 && sec <= 3) sfx.tick();
      lastSec = sec;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [snap.deadline, snap.turnMs, serverNow, mine]);
  return (
    <div className="timer">
      <div className="timer-track">
        <div className="timer-fill" ref={bar} />
      </div>
      <span className="timer-sec" ref={label} />
    </div>
  );
}

function Picking({ snap, you, send, name }: { snap: Snapshot; you: string; send: Send; name: (id: string | null) => string }) {
  const mine = snap.turnId === you;

  useEffect(() => {
    if (!mine) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const m = /^Key([A-Z])$/.exec(e.code); // physical key → works on any layout
      if (m) send({ t: 'pick', letter: m[1].toLowerCase() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mine, send]);

  if (!mine) {
    return (
      <div className="screen board">
        <p className="status">{t.picking(name(snap.turnId))}</p>
        <div className="big-letter pulse">?</div>
      </div>
    );
  }
  return (
    <div className="screen board">
      <p className="status strong">{t.pickFor(name(snap.nextId))}</p>
      <div className="letters">
        {LETTERS.map((l) => (
          <button key={l} onClick={() => send({ t: 'pick', letter: l })}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function Typing(props: {
  snap: Snapshot;
  you: string;
  send: Send;
  name: (id: string | null) => string;
  draft: { by: string; text: string } | null;
  reject: Reject | null;
}) {
  const { snap, you, send, name, draft, reject } = props;
  const mine = snap.turnId === you;
  const L = (snap.letter ?? '').toUpperCase();
  const roundWords = snap.chain.filter((c) => c.round === snap.round).slice(-4);

  return (
    <div className="screen board">
      <Chain words={roundWords.map((c) => c.word)} />
      <p className={mine ? 'status strong' : 'status'}>
        {mine ? t.yourTurn : t.turnOf(name(snap.turnId))} · {t.wordOn} <span className="letter-chip">{L}</span>
      </p>
      {mine ? (
        <WordInput key={`${snap.turnId}:${snap.used.length}:${snap.round}`} snap={snap} send={send} reject={reject} />
      ) : (
        <>
          <WordView text={draft?.by === snap.turnId ? draft.text : ''} letter={snap.letter!} used={snap.used} />
          <p className="hint"> </p>
        </>
      )}
    </div>
  );
}

function Chain({ words }: { words: string[] }) {
  if (!words.length) return <div className="chain" />;
  return (
    <div className="chain">
      {words.map((w, i) => (
        <span key={w} className={i === words.length - 1 ? 'chain-word last' : 'chain-word'}>
          {w.slice(0, -1)}
          <b>{w.slice(-1)}</b>
        </span>
      ))}
    </div>
  );
}

function wordFontSize(len: number): CSSProperties {
  return { fontSize: `min(${Math.min(64, Math.max(26, 560 / Math.max(7, len)))}px, ${Math.max(7, 90 / Math.max(6, len))}vw)` };
}

function WordView({ text, letter, used }: { text: string; letter: string; used: string[] }) {
  return (
    <div className="word-box">
      <div className={used.includes(text) ? 'word-mirror used' : 'word-mirror'} style={wordFontSize(text.length)}>
        {text ? (
          <>
            <span className={text[0] === letter ? 'first ok' : 'first bad'}>{text[0]}</span>
            {text.slice(1)}
          </>
        ) : (
          ' '
        )}
      </div>
    </div>
  );
}

function WordInput({ snap, send, reject }: { snap: Snapshot; send: Send; reject: Reject | null }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<WordError | 'not_your_turn' | 'slow_down' | null>(null);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const lastSent = useRef(0);
  const mountedAt = useRef(Date.now());
  const letter = snap.letter!;

  useEffect(() => {
    input.current?.focus();
    // Refocus when the player clicks anywhere — there is only one thing to type into.
    const refocus = () => input.current?.focus();
    window.addEventListener('pointerup', refocus);
    return () => window.removeEventListener('pointerup', refocus);
  }, []);

  useEffect(() => {
    if (!reject || reject.at < mountedAt.current) return;
    setError(reject.error);
    setShake((s) => s + 1);
    sfx.error();
  }, [reject]);

  const onChange = (raw: string) => {
    const v = normalizeInput(raw);
    setValue(v);
    setError(null);
    const now = Date.now();
    if (now - lastSent.current > 80 || v.length === 0) {
      lastSent.current = now;
      send({ t: 'typing', text: v });
    } else {
      setTimeout(() => send({ t: 'typing', text: input.current ? normalizeInput(input.current.value) : v }), 90);
    }
  };

  const submit = () => {
    const err = quickCheck(value, letter, (w) => snap.used.includes(w));
    if (err) {
      setError(err);
      setShake((s) => s + 1);
      sfx.error();
      return;
    }
    send({ t: 'word', text: value });
  };

  const shown = error;
  return (
    <>
      <div className="word-box" key={shake} data-shake={shake > 0}>
        <div className={snap.used.includes(value) ? 'word-mirror used' : 'word-mirror'} style={wordFontSize(value.length)} aria-hidden>
          {value ? (
            <>
              <span className={value[0] === letter ? 'first ok' : 'first bad'}>{value[0]}</span>
              {value.slice(1)}
            </>
          ) : (
            ' '
          )}
        </div>
        <input
          ref={input}
          className="word-input"
          style={wordFontSize(value.length)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          maxLength={40}
          aria-label={`${t.wordOn} ${letter.toUpperCase()}`}
        />
      </div>
      <p className={shown ? 'hint error' : 'hint'}>
        {shown ? t.errors[shown](letter.toUpperCase()) : ' '}
      </p>
    </>
  );
}

// ---------------- results ----------------

function Results({ snap, you, send }: { snap: Snapshot; you: string; send: Send }) {
  const winner = snap.players.find((p) => p.id === snap.winnerId);
  const ranked = [...snap.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  const enough = snap.members.length >= 2;
  return (
    <div className="screen results">
      {winner ? (
        <>
          <div className="trophy">
            <Avatar p={winner} size={96} />
            <span className="crown">👑</span>
          </div>
          <h2>{winner.id === you ? t.youWin : t.win(winner.name)}</h2>
        </>
      ) : (
        <h2>{t.nobody}</h2>
      )}
      <ol className="ranking">
        {ranked.map((p) => (
          <li key={p.id} className={p.id === you ? 'me' : ''}>
            <span className="place">{p.place ?? '–'}</span>
            <Avatar p={p} size={28} />
            <span className="rank-name">{p.name}</span>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button className="primary" disabled={!enough} onClick={() => send({ t: 'start' })}>
          {t.again}
        </button>
        <button className="ghost" onClick={() => send({ t: 'lobby' })}>
          {t.toLobby}
        </button>
      </div>
    </div>
  );
}

// ---------------- bits ----------------

function Avatar({ p, size }: { p: PlayerInfo; size: number }) {
  const [broken, setBroken] = useState(false);
  const hue = [...p.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const style = { width: size, height: size, fontSize: size * 0.42 } as CSSProperties;
  if (p.avatar && !broken) {
    return <img className="avatar" src={p.avatar} alt="" style={style} onError={() => setBroken(true)} draggable={false} />;
  }
  return (
    <span className="avatar initial" style={{ ...style, background: `hsl(${hue} 45% 38%)` }}>
      {p.name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function RulesButton({ turnSeconds, web = false }: { turnSeconds: number; web?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      e.stopPropagation(); // don't pick letters while reading the rules
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return (
    <>
      <button className="rules-btn" aria-label={t.rulesTitle} title={t.rulesTitle} onClick={() => setOpen(true)}>
        !
      </button>
      {open && (
        <div className="modal-bg" onPointerDown={() => setOpen(false)} onPointerUp={(e) => e.stopPropagation()}>
          <div className="modal" role="dialog" aria-label={t.rulesTitle} onPointerDown={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="×" onClick={() => setOpen(false)}>
              ×
            </button>
            <h2>{t.rulesTitle}</h2>
            <ol>
              {t.rules(turnSeconds, !web).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </>
  );
}

function MuteButton() {
  const [m, setM] = useState(isMuted());
  return (
    <button
      className="mute"
      aria-label={t.mute}
      title={t.mute}
      onClick={() => {
        setMuted(!m);
        setM(!m);
      }}
    >
      {m ? '🔇' : '🔊'}
    </button>
  );
}

function Center({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <div className={muted ? 'center muted' : 'center'}>{children}</div>;
}

/** Turns server events into a short toast + sounds. */
function useEventToasts(snap: Snapshot | null, you: string | null) {
  const seen = useRef<number | null>(null);
  const prev = useRef<Snapshot | null>(null);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => {
    if (!snap) return;
    const before = prev.current;
    prev.current = snap;
    const name = (id: string | null) =>
      id === you ? t.you : (snap.players.find((p) => p.id === id)?.name ?? snap.members.find((m) => m.id === id)?.name ?? '?');

    // Sounds driven by state transitions.
    if (before) {
      const myTurnNow = snap.turnId === you && (snap.phase === 'typing' || snap.phase === 'picking');
      const turnChanged = before.turnId !== snap.turnId || before.phase !== snap.phase;
      if (myTurnNow && turnChanged) sfx.yourTurn();
      else if (snap.used.length > before.used.length) sfx.ok();
    }

    const fresh = snap.events.filter((e) => seen.current !== null && e.seq > seen.current);
    if (snap.events.length) seen.current = Math.max(seen.current ?? 0, ...snap.events.map((e) => e.seq));
    if (seen.current === null) seen.current = 0;

    let text: string | null = null;
    for (const { e, seq } of fresh) {
      if (e.kind === 'timeout') {
        text = t.evTimeout(name(e.by));
        sfx.hurt();
      } else if (e.kind === 'out') text = e.reason === 'left' ? t.evLeft(name(e.by)) : t.evOut(name(e.by));
      else if (e.kind === 'picked' && e.auto) text = t.evAuto(e.letter.toUpperCase());
      else if (e.kind === 'win') sfx.win();
      if (text) setToast({ text, key: seq });
    }
  }, [snap, you]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  return toast;
}
