// Tiny synthesized sounds — no audio files, nothing to load through the Discord proxy.

let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem('ll-muted') === '1';
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem('ll-muted', m ? '1' : '0');
  } catch {
    /* storage can be unavailable in iframes */
  }
}

function tone(freq: number, ms: number, type: OscillatorType = 'sine', gain = 0.08, delay = 0) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + delay / 1000;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  } catch {
    /* audio not available */
  }
}

export const sfx = {
  yourTurn: () => {
    tone(660, 120, 'triangle');
    tone(880, 160, 'triangle', 0.08, 110);
  },
  tick: () => tone(1200, 50, 'square', 0.03),
  ok: () => tone(990, 90, 'sine', 0.06),
  error: () => tone(180, 160, 'sawtooth', 0.05),
  hurt: () => {
    tone(440, 140, 'triangle');
    tone(300, 220, 'triangle', 0.08, 120);
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 200, 'triangle', 0.07, i * 120)),
};
