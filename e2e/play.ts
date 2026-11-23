// End-to-end: real server + 3 real browsers play a full game until somebody wins.
// Run: npm run build && npm run e2e   (screenshots → e2e/shots/)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { loadDictionary } from '../src/server/dictionary';

const PORT = 4100;
const BASE = `http://localhost:${PORT}`;
const SHOTS = 'e2e/shots';
mkdirSync(SHOTS, { recursive: true });

const words = [...loadDictionary()].filter((w) => w.length >= 4 && w.length <= 7);
const submitted = new Set<string>();
function wordFor(letter: string): string {
  const pool = words.filter((w) => w[0] === letter && !submitted.has(w));
  const w = pool[Math.floor(Math.random() * pool.length)];
  submitted.add(w);
  return w;
}

function log(...a: unknown[]) {
  console.log(`[e2e ${new Date().toISOString().slice(14, 19)}]`, ...a);
}

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', ALLOW_GUESTS: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((ok) => server.stdout!.on('data', (d) => String(d).includes('[last-letter]') && ok()));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const errors: string[] = [];

async function open(name: string, lang: string, viewport = { width: 900, height: 640 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}/?room=e2e&name=${name}&lang=${lang}`);
  return { name, page };
}

let ok = false;
try {
  const alice = await open('Alice', 'ru');
  const bob = await open('Bob', 'ru', { width: 390, height: 720 }); // phone-sized
  const cid = await open('Cid', 'en');
  const all = [alice, bob, cid];

  await alice.page.waitForFunction(() => document.querySelectorAll('.member').length === 3);
  await alice.page.screenshot({ path: `${SHOTS}/01-lobby.png` });
  if ((await alice.page.locator('.segmented .on').textContent()) !== '15с') throw new Error('default must be 15s');
  if (await alice.page.locator('.hint, .footnote, .tagline').count()) throw new Error('lobby must have no hints');
  log('lobby ok');

  // rules live behind the (!) button
  await bob.page.getByRole('button', { name: 'Правила' }).click();
  await bob.page.waitForSelector('.modal li');
  await bob.page.screenshot({ path: `${SHOTS}/01b-rules.png` });
  await bob.page.keyboard.press('Escape');
  await bob.page.waitForSelector('.modal', { state: 'detached' });
  log('rules modal ok');

  await alice.page.getByRole('radio', { name: '20с' }).click();
  await cid.page.waitForFunction(() => document.querySelector('.segmented .on')?.textContent === '20s');
  await alice.page.getByRole('button', { name: 'Начать' }).click();

  const whoHas = async (sel: string) => {
    for (;;) {
      for (const p of all) if (await p.page.locator(sel).count()) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // --- first pick via physical key
  const picker = await whoHas('.letters');
  await picker.page.screenshot({ path: `${SHOTS}/02-picking.png` });
  await picker.page.keyboard.press('KeyC');
  log(`${picker.name} picked C`);

  // --- first writer: rejected word, then a real one, while others watch the draft
  let writer = await whoHas('.word-input');
  await writer.page.keyboard.type('cxzqv');
  const watcher = all.find((p) => p !== writer && p !== picker) ?? picker;
  await watcher.page.waitForFunction(() => document.querySelector('.word-mirror')?.textContent === 'cxzqv');
  await writer.page.keyboard.press('Enter');
  await writer.page.waitForSelector('.hint.error');
  log(`${writer.name} reject shown: "${await writer.page.locator('.hint.error').textContent()}"`);
  await writer.page.screenshot({ path: `${SHOTS}/03-rejected.png` });
  await watcher.page.screenshot({ path: `${SHOTS}/04-watching-draft.png` });

  await writer.page.locator('.word-input').fill('');
  await writer.page.keyboard.type('ca');
  // wrong-letter live hint
  await writer.page.locator('.word-input').fill('bat');
  if (await writer.page.locator('.hint.error').count()) throw new Error('no live hints while typing');
  await writer.page.keyboard.press('Enter');
  await writer.page.waitForSelector('.hint.error');
  await writer.page.locator('.word-input').fill('');
  await writer.page.keyboard.type('cat');
  await writer.page.keyboard.press('Enter');
  submitted.add('cat');
  await writer.page.waitForSelector('.word-input', { state: 'detached' });

  // --- second writer types on a Russian layout: "ещзшс" → "topic"
  writer = await whoHas('.word-input');
  await writer.page.waitForFunction(() => document.querySelector('.letter-chip')?.textContent === 'T');
  await writer.page.keyboard.type('ещзшс');
  await writer.page.waitForFunction(() => document.querySelector('.word-mirror')?.textContent === 'topic');
  await writer.page.screenshot({ path: `${SHOTS}/05-layout-fixed.png` });
  await writer.page.keyboard.press('Enter');
  submitted.add('topic');
  await writer.page.waitForFunction(() => !document.querySelector('.word-input'));
  await (await whoHas('.word-input')).page.screenshot({ path: `${SHOTS}/06-chain.png` });
  log('russian layout ok');

  // --- play until somebody wins: Cid never answers, then Bob never answers.
  let loser = 'Cid';
  let shotTimeout = false;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (await alice.page.locator('.results').count()) break;
    for (const p of all) {
      if (await p.page.locator('.letters').count()) {
        await p.page.keyboard.press(`Key${'ABCDEFGHILMNOPRST'[Math.floor(Math.random() * 17)]}`);
      } else if (await p.page.locator('.word-input').count()) {
        if (p.name === loser) continue;
        const letter = (await p.page.locator('.letter-chip').textContent())!.toLowerCase();
        await p.page.locator('.word-input').fill(wordFor(letter));
        await p.page.keyboard.press('Enter');
        await p.page.waitForTimeout(150);
      }
    }
    if (!shotTimeout && (await alice.page.locator('.toast').count())) {
      shotTimeout = true;
      await alice.page.screenshot({ path: `${SHOTS}/07-timeout-toast.png` });
      await bob.page.screenshot({ path: `${SHOTS}/08-mobile.png` });
      log('toast:', await alice.page.locator('.toast').textContent());
    }
    if (loser === 'Cid' && (await alice.page.locator('.chip.out').count()) === 1) {
      log('Cid eliminated');
      loser = 'Bob';
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  await alice.page.waitForSelector('.results', { timeout: 5000 });
  await alice.page.screenshot({ path: `${SHOTS}/09-results.png` });
  await cid.page.screenshot({ path: `${SHOTS}/10-results-en.png` });
  const title = await alice.page.locator('.results h2').textContent();
  log('result:', title);
  if (!title?.includes('Ты победил')) throw new Error('Alice should have won, got: ' + title);

  // --- play again starts straight away with everyone
  await bob.page.getByRole('button', { name: 'Играть снова' }).click();
  await alice.page.waitForSelector('.chip');
  const hp = await alice.page.locator('.heart:not(.lost)').count();
  if (hp !== 9) throw new Error('fresh game should give 3×3 hearts, got ' + hp);
  log('play again ok');

  if (errors.length) throw new Error('browser errors:\n' + errors.join('\n'));
  ok = true;
  log('PASS');
} finally {
  await browser.close();
  server.kill();
  if (!ok) process.exitCode = 1;
}
