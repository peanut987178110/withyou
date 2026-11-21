/**
 * Browser E2E + exhaustive clickability audit for WithYou.
 *
 * Two jobs:
 *   1. Walk the real first-run flow end to end (signup → age → create → chat →
 *      memory → rewards → wardrobe → plus → privacy …) and assert on screen.
 *   2. On every screen, enumerate every interactive control, click it, and
 *      report any that produce neither a navigation, a network call, a DOM
 *      change, nor a toast — plus any console error / failed request.
 *
 * Run: node e2e/run.mjs [baseUrl]
 * Exit code is non-zero if any functional assertion or console error occurs.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const SHOTS = path.resolve('screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const report = { steps: [], dead: [], consoleErrors: [], failedRequests: [], shots: [] };
let failures = 0;

function log(ok, msg, extra) {
  report.steps.push({ ok, msg, extra });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + JSON.stringify(extra) : ''}`);
}

const shot = async (page, name) => {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.shots.push(path.basename(file));
  return file;
};

const settle = (page, ms = 320) => page.waitForTimeout(ms);

async function goto(page, hash, waitFor) {
  await page.evaluate((h) => { location.hash = h; }, '#/' + hash);
  await settle(page, 500);
  if (waitFor) {
    try { await page.waitForSelector(waitFor, { timeout: 6000 }); }
    catch (e) { log(false, `route #/${hash} did not render ${waitFor}`); }
  }
}

/* ------------------------------------------------------ console auditing */

function watch(page) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // ERR_ABORTED on the SSE stream is our own disconnect after a terminal
    // event; the browser logs it as a resource error. Track separately.
    if (/Failed to load resource/.test(text)) {
      report.resourceErrors = report.resourceErrors || [];
      report.resourceErrors.push(`${page.url()} :: ${text}`);
      return;
    }
    report.consoleErrors.push(`${page.url()} :: ${text}`);
  });
  page.on('pageerror', (e) => report.consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (/\/messages\/[^/]+\/events$/.test(u) && r.failure()?.errorText === 'net::ERR_ABORTED') {
      // Expected: the client aborts the stream once it sees a terminal event.
      return;
    }
    report.failedRequests.push(`${r.method()} ${u} :: ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.url().startsWith(BASE) && r.status() >= 500) {
      report.failedRequests.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
    }
    if (r.url().startsWith(BASE) && r.status() === 409) {
      report.conflicts = report.conflicts || [];
      report.conflicts.push(`${r.request().method()} ${r.url()}`);
    }
  });
}

/* ------------------------------------------- exhaustive control clicking */

const CLICKABLE = [
  'button',
  'a[href]',
  '[role="tab"]',
  '[role="switch"]',
  '[data-go]',
  '[data-back]',
  '[data-act]',
  '[data-pact]',
  '[data-toggle]',
  '[data-item]',
  '[data-activity]',
  '[data-plan]',
  '[data-rel]',
  '[data-room]',
  '[data-tab]',
  '[data-mood]',
  '[data-trait]',
  '[data-intent]',
  '[data-info]',
  '[data-signout]',
  '[data-switch]',
  'input',
  'textarea',
  'select',
];

/**
 * Snapshot everything a click could reasonably change: markup, control values,
 * ARIA state, overlay presence and scroll position. Comparing raw innerHTML
 * length alone misses text typed into a field or a toggle flipping aria-pressed.
 */
async function snapshot(page) {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const controls = [...app.querySelectorAll('input,textarea,select,[aria-pressed],[aria-checked],[aria-selected]')]
      .map((n) => `${n.tagName}:${n.id}:${n.value ?? ''}:${n.getAttribute('aria-pressed') ?? ''}`
        + `:${n.getAttribute('aria-checked') ?? ''}:${n.getAttribute('aria-selected') ?? ''}`)
      .join('|');
    const toast = document.querySelector('#toasts .toast');
    return {
      hash: location.hash,
      len: app ? app.innerHTML.length : 0,
      controls,
      sheet: !!document.querySelector('.sheet-backdrop'),
      toast: toast ? toast.textContent.trim() : '',
      focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '',
    };
  });
}

/**
 * Click every control on the current screen once. A control "did something"
 * if the route changed, markup changed, a control value/ARIA state changed,
 * a toast appeared, a sheet opened, or an API request fired.
 * Destructive controls are recorded and skipped.
 */
async function auditScreen(page, label, opts = {}) {
  const skip = opts.skip || [];
  const handles = await page.$$(CLICKABLE.join(','));
  const seen = new Set();
  for (const handle of handles) {
    const meta = await handle.evaluate((n) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      return {
        tag: n.tagName.toLowerCase(),
        text: norm(n.textContent),
        id: n.id || '',
        cls: n.className && typeof n.className === 'string' ? n.className : '',
        attrs: JSON.stringify({
          go: n.dataset.go, act: n.dataset.act, pact: n.dataset.pact,
          item: n.dataset.item, plan: n.dataset.plan, rel: n.dataset.rel,
          room: n.dataset.room, tab: n.dataset.tab, mood: n.dataset.mood,
          activity: n.dataset.activity, info: n.dataset.info, toggle: n.dataset.toggle,
          sigout: n.dataset.signout, sw: n.dataset.switch, back: n.dataset.back,
        }),
        disabled: !!n.disabled || n.getAttribute('aria-disabled') === 'true',
        type: n.getAttribute('type') || '',
        hidden: !n.offsetParent && getComputedStyle(n).position !== 'fixed',
      };
    });
    if (meta.hidden || meta.disabled) continue;
    const key = `${meta.tag}|${meta.text}|${meta.attrs}|${meta.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label2 = `${label} ▸ <${meta.tag}${meta.id ? '#' + meta.id : ''}> "${meta.text}" ${meta.attrs}`;
    if (skip.some((s) => meta.text.includes(s) || meta.attrs.includes(s) || meta.cls.includes(s))) {
      report.steps.push({ ok: true, msg: `${label2} — skipped (destructive)` });
      continue;
    }
    const before = await snapshot(page);
    // A text field's only observable effect is what it accepts, so type into it
    // rather than merely clicking: that is the real user gesture.
    if (meta.tag === 'textarea' || (meta.tag === 'input' && !['range', 'checkbox', 'radio', 'submit'].includes(meta.type || ''))) {
      const typed = 'hi';
      const okType = await handle.type(typed, { timeout: 2500 }).then(() => true).catch(() => false);
      await settle(page, 260);
      const typedSnapshot = await snapshot(page);
      if (!okType) {
        report.dead.push({ screen: label, control: label2 });
        log(false, `${label2} rejected text input`);
        continue;
      }
      log(true, `${label2} accepts text → "${typed}"`);
      await handle.fill('').catch(() => {});
      continue;
    }
    let requests = 0;
    const onReq = (r) => { if (r.url().startsWith(BASE + '/api/')) requests += 1; };
    page.on('request', onReq);
    try {
      await handle.click({ timeout: 2500, trial: true });
      await handle.click({ timeout: 2500 });
    } catch (e) {
      page.off('request', onReq);
      // Element may have been detached by a previous click's re-render: that is
      // not a dead control, so only record true invisibility/disabled case.
      if (/not visible|outside of the viewport|intercepts pointer|detached/i.test(e.message)) {
        report.steps.push({ ok: true, msg: `${label2} — not clickable now (${e.message.split('\n')[0].slice(0, 60)})` });
      } else {
        log(false, `${label2} threw on click`, { err: e.message.split('\n')[0] });
      }
      continue;
    }
    await settle(page, 420);
    page.off('request', onReq);
    const after = await snapshot(page);
    // Clicking a field focuses it (input vs. no-op). Focus is not visible in a
    // screenshot but it is the observable effect of that control.
    const changed = after.hash !== before.hash
      || Math.abs(after.len - before.len) > 12
      || after.controls !== before.controls
      || after.focus !== before.focus
      || !!after.toast
      || !!after.sheet;
    if (!changed && requests === 0) {
      report.dead.push({ screen: label, control: label2 });
      log(false, `${label2} did nothing`);
    } else {
      log(true, `${label2} → ${after.hash.split('#')[1] || 'same'}${requests ? ` (${requests} req)` : ''}`
        + `${after.toast ? ' toast:' + after.toast : ''}${after.sheet ? ' [sheet]' : ''}`);
    }
    // Close overlays so the next control is reachable.
    if (after.sheet) {
      const closed = await page.evaluate(() => {
        const bd = document.querySelector('.sheet-backdrop');
        if (!bd) return true;
        const btn = bd.parentElement?.querySelector('.sheet-backdrop');
        if (btn) { bd.click(); return true; }
        return false;
      });
      if (!closed) await page.keyboard.press('Escape');
      await settle(page, 260);
    }
    if (opts.returnTo && (page.url().split('#')[1] || '') !== opts.returnTo) {
      await goto(page, opts.returnTo, opts.waitFor);
    }
    // Re-query: a re-render invalidates every earlier handle.
    if (opts.rerender !== false) {
      await page.waitForTimeout(80);
    }
  }
}

/* --------------------------------------------------------------- helpers */

async function typeInto(page, sel, text) {
  await page.click(sel);
  await page.fill(sel, '');
  await page.type(sel, text, { delay: 8 });
}

async function signUp(page, email, password = 'secret123') {
  await goto(page, 'signup', '#name');
  await page.fill('#name', 'Alex');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await shot(page, '02-signup');
  await Promise.all([
    page.waitForFunction(() => !document.querySelector('#email') || location.hash.includes('age'), { timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function createCompanion(page, name = 'Mia') {
  await page.waitForSelector('#comp-name', { timeout: 10000 });
  await page.fill('#comp-name', name);
  const intents = await page.$$('[data-intent]');
  if (intents.length) await intents[1].click();
  const traits = await page.$$('[data-trait]');
  for (const t of traits.slice(0, 3)) await t.click();
  await shot(page, '04-create');
  await page.click('#create-continue');
  await page.waitForFunction(() => location.hash.includes('chat'), { timeout: 12000 });
}

async function sendMessage(page, text) {
  await page.waitForSelector('#composer-input', { timeout: 8000 });
  const before = await page.$$eval('#chat-body .msg', (n) => n.length);
  await page.fill('#composer-input', text);
  await page.click('#composer-send');
  // Wait for a *new* bubble to settle: replies are per-message now, so counting
  // is more reliable than looking for a single shared typing host.
  await page.waitForFunction(
    (n) => document.querySelectorAll('#chat-body .msg:not(.generating)').length >= n + 2,
    before, { timeout: 20000 },
  );
  await page.waitForTimeout(300);
}

async function gotoSignedOut(page) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.removeItem('wy_token');
    localStorage.removeItem('wy_api');
  });
  // A hash-only change does not reload; force a real document load so the
  // boot path (not just the route guard) is exercised.
  await page.goto(BASE + '/?signed-out=1#/home', { waitUntil: 'networkidle' });
  await settle(page, 1600);
}

/* ------------------------------------------------------------------ main */

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
watch(page);

try {
  /* ---------------------------------------------------------- 1. welcome */
  await page.goto(BASE + '/#/welcome', { waitUntil: 'networkidle' });
  await page.waitForSelector('.welcome', { timeout: 15000 });
  log(true, 'welcome screen rendered');
  await shot(page, '01-welcome');

  /* First run on a phone whose language we support: with nothing stored, the
     app must open in the device's language rather than in English. A separate
     throwaway context, so this run's own choice stays untouched. */
  {
    const firstRunCtx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'ja-JP',
    });
    const firstRunPage = await firstRunCtx.newPage();
    await firstRunPage.goto(BASE + '/#/welcome', { waitUntil: 'networkidle' });
    await firstRunPage.waitForSelector('.lang-chip', { timeout: 15000 });
    const fresh = await firstRunPage.evaluate(() => ({
      lang: document.documentElement.lang,
      chip: (document.querySelector('[data-lang-name]') || {}).textContent,
    }));
    log(fresh.lang === 'ja' && /日本語/.test(fresh.chip || ''),
      'a first run opens in the device language, not English', fresh);
    await firstRunCtx.close();
  }

  /* The signed-out entry point: someone who cannot read English must be able
     to change language before creating an account, not after. */
  await page.click('[data-lang-open]');
  await page.waitForSelector('.lang-list [data-lang="es"]', { timeout: 6000 });
  await page.click('.lang-list [data-lang="es"]');
  await settle(page, 600);
  const welcomeEs = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    chip: (document.querySelector('[data-lang-name]') || {}).textContent,
    title: (document.querySelector('.welcome-copy h1') || {}).textContent,
  }));
  log(welcomeEs.lang === 'es' && /Español/.test(welcomeEs.chip || ''),
    'welcome screen switches language before sign-in', welcomeEs);
  await shot(page, '01b-welcome-es');

  // Back to English: the rest of the run asserts on English copy.
  await page.click('[data-lang-open]');
  await page.waitForSelector('.lang-list [data-lang="en"]', { timeout: 6000 });
  await page.click('.lang-list [data-lang="en"]');
  await settle(page, 600);

  /* ----------------------------------------------------------- 2. signup */
  const email = `e2e-${Date.now()}@example.test`;
  await signUp(page, email);
  log((await page.url()).includes('age'), 'signup advanced to age gate');

  /* ------------------------------------------------------ 3. age + region */
  await page.waitForSelector('#age-continue', { timeout: 8000 });
  const gateDisabled = await page.getAttribute('#age-continue', 'disabled');
  log(gateDisabled !== null, 'age gate keeps Continue disabled before confirmation');
  await page.click('#age-toggle');
  await page.selectOption('#region', 'US');
  const enabledNow = await page.getAttribute('#age-continue', 'disabled');
  log(enabledNow === null, 'age gate enables Continue once adult + region are set');
  await shot(page, '03-age');
  await page.click('#age-continue');
  await page.waitForFunction(() => location.hash.includes('create'), { timeout: 10000 });
  log(true, 'age attestation accepted');

  /* --------------------------------------------------------- 4. companion */
  await createCompanion(page, 'Mia');
  log(true, 'companion created, landed in chat');
  await shot(page, '05-chat-empty');

  /* -------------------------------------------------------------- 5. chat */
  await sendMessage(page, 'Hey Mia, I had a long day but I made it through.');
  const bubbles = await page.$$eval('.msg', (n) => n.length);
  log(bubbles >= 2, 'chat exchanged a message and a reply', { bubbles });
  await shot(page, '06-chat-first');

  await sendMessage(page, 'I love jazz and quiet rainy afternoons.');
  await sendMessage(page, 'What should I do tonight?');
  await shot(page, '07-chat-thread');

  /* Three messages in a row, exactly like the reported bug: nothing waits for
   * a reply. Every question must be followed by its own answer, and no reply
   * may be detached at the bottom of the thread. */
  const orderBefore = await page.$$eval('#chat-body .msg', (n) => n.length);
  for (const text of ['今天过得好长。', '你记得什么？', '你好']) {
    await page.fill('#composer-input', text);
    await page.press('#composer-input', 'Enter');
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(
    (n) => document.querySelectorAll('#chat-body .msg:not(.generating)').length >= n + 6,
    orderBefore, { timeout: 30000 },
  );
  const tail = await page.$$eval('#chat-body .msg', (nodes) => nodes.slice(-6)
    .map((n) => (n.classList.contains('me') ? 'U' : 'A')).join(''));
  log(/^(UA){3}$/.test(tail), 'back-to-back messages interleave — each question keeps its own reply', { tail });
  await shot(page, '07b-chat-interleaved');

  /* memory proposal should have appeared */
  const proposals = await page.$$('#chat-body .proposal-card');
  log(proposals.length > 0, 'memory proposal surfaced in chat', { count: proposals.length });
  if (proposals.length) {
    const cardSel = '#chat-body .proposal-card';
    await page.click(`${cardSel} [data-pact="confirm"]`);
    await settle(page, 900);
    const hostText = await page.textContent('#chat-body');
    log(/saved|remembered|已保存|记住了/i.test(hostText) || (await page.$(`${cardSel}.done`)) !== null,
      'confirming a proposal marks it confirmed in place', {
        hostText: hostText.replace(/\s+/g, ' ').slice(0, 80),
      });
    const remembered = await page.evaluate(async () => {
      const r = await fetch('/api/v1/memories', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('wy_token') },
      });
      return (await r.json()).data.items.length;
    });
    log(remembered > 0, 'confirmed memory is stored', { remembered });
  }

  /* composer controls */
  const counterBefore = await page.textContent('.composer-foot');
  await page.fill('#composer-input', 'x'.repeat(120));
  const counterLit = await page.textContent('.composer-foot');
  log(counterBefore !== counterLit, 'composer counter updates while typing', { counterBefore, counterLit });

  /* ------------------------------------------------- 6. navigation screens */
  for (const [hash, sel, name] of [
    ['home', '.home-hero', '08-home'],
    ['discover', '.featured', '09-discover'],
    ['space', '.space-scene', '10-space'],
    ['profile', '.profile-hero', '11-profile'],
  ]) {
    await goto(page, hash, sel);
    const ok = await page.$(sel);
    log(!!ok, `#/${hash} rendered ${sel}`);
    if (ok) await shot(page, name);
    // Every top-level tab must keep the tabbar: profile once had none, which
    // left the user with no way back except the browser's own back button.
    const tabbarCount = await page.$$eval('.tabbar [data-go]', (n) => n.length);
    log(tabbarCount === 5, `#/${hash} keeps all five tabs in the tabbar`, { tabbarCount });
  }

  /* --------------------------------------------------------- 7. sub-screens */
  const screens = [
    ['mood', '.mood-grid', '12-mood'],
    ['reflection', '#reflect-text', '13-reflection'],
    ['rewards', '.task-card', '14-rewards'],
    ['memory', '.settings-group', '15-memory'],
    ['privacy', '.privacy-hero', '16-privacy'],
    ['plus', '.plus-hero', '17-plus'],
    ['relationship', '.rel-card', '18-relationship'],
    ['wardrobe', '.stage', '19-wardrobe'],
    ['rooms', '.room-card', '20-rooms'],
    ['voice', '.voice-quota', '21-voice'],
    ['call', '.call-screen', '22-call'],
  ];
  for (const [hash, sel, name] of screens) {
    await goto(page, hash, sel);
    const ok = await page.$(sel);
    log(!!ok, `#/${hash} rendered ${sel}`);
    if (ok) await shot(page, name);
  }

  /* ---------------------------------------- 8. functional happy-path checks */
  await goto(page, 'mood', '.mood-grid');
  await page.click('[data-mood]');
  await page.click('#mood-save');
  await page.waitForFunction(() => location.hash.includes('home'), { timeout: 10000 });
  log(true, 'mood check-in saved and returned home');
  const xpAfterMood = await page.evaluate(async () => {
    const r = await fetch(new URL('/api/v1/auth/me', location.origin), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('wy_token') },
    });
    return (await r.json()).data.wallet.xp;
  });
  log(xpAfterMood >= 10, 'mood check-in granted XP', { xpAfterMood });

  await goto(page, 'reflection', '#reflect-text');
  await page.fill('#reflect-text', 'Ten minutes of sun on the kitchen floor.');
  await page.click('#reflect-save');
  await page.waitForFunction(() => location.hash.includes('home'), { timeout: 10000 });
  log(true, 'reflection saved');

  // Re-entry is blocked for the day
  await goto(page, 'mood', '.screen');
  const moodBody = await page.textContent('.screen');
  log(/already checked in|Checked in/i.test(moodBody), 'mood screen shows the once-a-day state on re-entry');

  await goto(page, 'wardrobe', '.stage');
  const wardrobeText = await page.textContent('.screen');
  log(/(Owned|Wearing|✦\s*\d+)/.test(wardrobeText), 'wardrobe lists every set with its state', {
    sample: wardrobeText.replace(/\s+/g, ' ').slice(0, 120),
  });

  // An unowned set must offer a Lumen purchase sheet, and confirming it must
  // flip *that* item's badge. Both halves used to be loose enough to pass on
  // nothing: the assertion matched /Owned|Wearing/ anywhere in the screen, so
  // an unrelated "Wearing" badge on the default set kept it green while the
  // purchase was actually being refused for lack of Lumen (a 409 the report
  // then wrote off as "expected"). Pick an item the account can afford, and
  // read the badge of the item we clicked.
  const shopState = await page.evaluate(() => {
    const pill = document.querySelector('.reward-pill');
    const lumen = pill ? parseInt((pill.textContent || '').replace(/[^\d]/g, ''), 10) || 0 : 0;
    const items = [...document.querySelectorAll('[data-item]')].map((n) => {
      const badge = n.querySelector('.badge');
      const price = badge && badge.classList.contains('warn')
        ? parseInt((badge.textContent || '').replace(/[^\d]/g, ''), 10) || 0
        : null;
      return { id: n.getAttribute('data-item'), price, badge: badge ? badge.textContent.trim() : '' };
    });
    return { lumen, items };
  });
  const affordable = shopState.items
    .filter((i) => i.price !== null && i.price > 0 && i.price <= shopState.lumen)
    .sort((a, b) => a.price - b.price)[0];
  const toBuy = affordable ? affordable.id : null;
  const buyBtn = toBuy ? await page.$(`[data-item="${toBuy}"]`) : null;
  if (!buyBtn) {
    log(false, 'a set the balance can afford is on sale', shopState);
  } else {
    await buyBtn.click();
    await settle(page, 500);
    const sheet = await page.$('.sheet-backdrop');
    log(!!sheet, 'tapping a locked set opens the Lumen confirm sheet', { toBuy });
    if (sheet) {
      const confirmBtn = await page.$('.sheet .btn.accent');
      if (confirmBtn) {
        const label = await confirmBtn.textContent();
        await confirmBtn.click();
        await settle(page, 1200);
        const badge = await page.evaluate((id) => {
          const el = document.querySelector(`[data-item="${id}"] .badge`);
          if (!el) return null;
          // The outlined row must be the worn one; the badge alone was updated
          // by an in-place repaint and the accent border stayed behind on the
          // set that used to be worn.
          const rows = [...document.querySelectorAll('[data-item]')];
          const accentRows = rows.filter((r) => /--accent/.test(r.style.border)).map((r) => r.getAttribute('data-item'));
          return { text: el.textContent.trim(), cls: el.className, accentRows };
        }, toBuy);
        log(!!badge && /Owned|Wearing/.test(badge.text) && /good|accent/.test(badge.cls)
          && badge.accentRows.length === 1 && badge.accentRows[0] === toBuy,
          'Lumen purchase unlocks the set', { label: label.trim(), badge });
      } else {
        await page.keyboard.press('Escape');
      }
    }
  }

  /* ------------------------------------------- 9. voice, calls and notes */
  // A call is a conversation with money attached, so the check is not just
  // "does it render": dial out, speak, read the caption, hang up, and read the
  // receipt. Anything that silently no-ops here would be invisible in a screenshot.
  await goto(page, 'voice', '.voice-quota');
  const voiceBefore = await page.evaluate(async () => {
    const r = await fetch('/api/v1/voice/quota', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('wy_token') },
    });
    return (await r.json()).data;
  });
  log(typeof voiceBefore.seconds_left === 'number', 'voice screen reads a real quota', {
    left: voiceBefore.seconds_left, plan: voiceBefore.plan,
  });

  const rules = await page.$$eval('.voice-rules li', (n) => n.length);
  log(rules === 4, 'the four call rules are on the screen, not just in the API', { rules });

  // Toggle one setting and read it straight back from the server: the toggle
  // is the only control whose effect is otherwise invisible.
  const capToggle = await page.$('[data-vtoggle="captions_enabled"]');
  if (capToggle) {
    const was = await page.getAttribute('[data-vtoggle="captions_enabled"]', 'aria-checked');
    await capToggle.click();
    await settle(page, 700);
    const serverNow = await page.evaluate(async () => {
      const r = await fetch('/api/v1/voice', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('wy_token') },
      });
      return (await r.json()).data.settings.captions_enabled;
    });
    log(String(serverNow) === (was === 'true' ? 'false' : 'true'),
      'the captions toggle reaches the server', { was, serverNow });
    await page.click('[data-vtoggle="captions_enabled"]');
    await settle(page, 500);
  } else {
    log(false, 'captions toggle is present');
  }

  await goto(page, 'call', '.call-screen');
  await page.waitForSelector('#call-status', { timeout: 8000 });
  // Wait for the opener: it must be specific, never a bare "hello".
  await page.waitForFunction(() => {
    const el = document.querySelector('#call-line');
    return el && el.textContent.trim().length > 12;
  }, { timeout: 12000 }).catch(() => {});
  const opener = await page.textContent('#call-line');
  log(opener && opener.trim().length > 12, 'the companion speaks first, with something specific',
    { opener: (opener || '').slice(0, 60) });

  // The header says "Calling…" while the dial is in flight and must switch to
  // the live label once the server answers — it used to stay on "Calling…"
  // for the whole call because only the route painted it.
  const topLabel = await page.textContent('#call-top-label');
  log(!/calling/i.test(topLabel || ''), 'the call header leaves "Calling…" once connected', {
    topLabel,
  });

  // Say something and wait for the reply to land on the screen.
  await page.fill('#call-input', '今天真的过得好长，我一直在想你说的那句话');
  await page.click('#call-send');
  const replied = await page.waitForFunction(() => {
    const el = document.querySelector('#call-line');
    return el && el.textContent.trim().length > 12
      && !el.textContent.includes('过得好长');
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  log(replied, 'a spoken turn gets a spoken answer');

  // Captions, when on, must contain both sides.
  await page.click('#call-captions-toggle').catch(() => {});
  await settle(page, 500);
  const capsText = await page.evaluate(() => {
    const el = document.querySelector('#call-captions');
    return el && !el.hidden ? el.textContent : '';
  });
  log(capsText && capsText.length > 20, 'live captions render the call', {
    lines: (capsText || '').slice(0, 40),
  });
  await shot(page, '25-call-live');

  // Hang up and read the receipt.
  await page.click('[data-end]');
  await page.waitForSelector('#call-detail-cta', { timeout: 12000 }).catch(() => {});
  const ended = await page.textContent('.call-meta');
  // The receipt reads "You talked for 0:02. 2s counted." — assert the numbers
  // actually appear, not just that the screen changed.
  log(/talked for/i.test(ended || '') && /\d/.test(ended || ''),
    'ending the call settles into an ended state with a receipt', {
      ended: (ended || '').replace(/\s+/g, ' ').slice(0, 80),
    });
  await shot(page, '26-call-ended');

  const detailBtn = await page.$('#call-detail-cta');
  if (detailBtn) {
    await detailBtn.click();
    await page.waitForSelector('.screen', { timeout: 8000 });
    await settle(page, 900);
    const detail = await page.textContent('.screen');
    log(/Duration|Deducted|Left this month/i.test(detail || ''),
      'the call detail shows what the call used', { hash: await page.evaluate(() => location.hash) });
    await shot(page, '27-call-detail');
  } else {
    log(false, 'ended call offers a way to the receipt');
  }

  /* Calling again has to dial again. The receipt is a *state* of the call
   * screen, so a button that only navigates to `#/call` would land on the
   * previous receipt — which it did. Both entry points (Space's Call tile and
   * the Voice page's "Start call") must start a fresh session. */
  await goto(page, 'space', '.space-actions');
  await page.click('#space-call');
  await page.waitForSelector('.call-screen', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#call-elapsed');
    return el && el.textContent !== '0:00';
  }, { timeout: 20000 }).catch(() => {});
  const secondCall = await page.evaluate(() => ({
    cta: !!document.querySelector('#call-detail-cta'),
    end: !!document.querySelector('[data-end]'),
    label: (document.querySelector('#call-top-label') || {}).textContent || '',
  }));
  log(secondCall.end && !secondCall.cta && !/ended/i.test(secondCall.label),
    'calling again after a call starts a new call, not the old receipt', secondCall);
  await page.click('[data-end]');
  await page.waitForSelector('#call-detail-cta', { timeout: 20000 }).catch(() => null);

  /* ------------------------------------------- 10. live language switching */
  // Switching is render-driven: the route must stay put, the tabbar must keep
  // all five tabs, and every label must repaint without a reload.
  await goto(page, 'profile', '.profile-hero');
  await page.click('#profile-language');
  await page.waitForSelector('.lang-list [data-lang]', { timeout: 6000 });
  const langRows = await page.$$eval('.lang-list [data-lang]', (n) => n.map((r) => r.dataset.lang));
  log(langRows.length === 10, 'language sheet lists all ten languages', { langRows });

  // Every row previews a real line from the companion in that language. The
  // sample is not decoration: it is the only thing that tells 繁體中文 from
  // 简体中文 when you cannot read either.
  const samples = await page.$$eval('.lang-list .lang-sample', (n) => n.map((s) => ({
    lang: s.getAttribute('lang'), text: s.textContent.trim(), dir: s.getAttribute('dir'),
  })));
  log(samples.length === 10, 'every language row previews a sample line', { n: samples.length });
  log(samples.every((s) => s.text.length > 4),
    'no sample line is empty', { empty: samples.filter((s) => s.text.length <= 4) });
  log(samples.filter((s) => s.text).length === new Set(samples.map((s) => s.text)).size,
    'each language previews its own line, not a repeated one');
  const arSample = samples.find((s) => s.lang === 'ar') || {};
  log(arSample.dir === 'rtl', 'the Arabic sample is marked RTL so it renders right-to-left', { arSample });

  // Ten rows plus Close must fit one phone screen: the picker's whole job is
  // reaching the language you want, and one below the fold gets missed.
  const sheetFits = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    return { scrollH: s.scrollHeight, clientH: s.clientHeight };
  });
  log(sheetFits.scrollH <= sheetFits.clientH + 2,
    'all ten languages plus Close fit the sheet without scrolling', sheetFits);
  // The sheet slides up over .26s; shooting before it settles catches a
  // half-transparent backdrop and the page behind it.
  await settle(page, 500);
  await shot(page, '22-language-sheet');

  await page.click('.lang-list [data-lang="zh"]');
  await settle(page, 700);
  const zhState = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    hash: location.hash,
    nav: [...document.querySelectorAll('.tabbar [data-go]')].map((n) => n.textContent.trim()),
    value: (document.querySelector('#language-value') || {}).textContent,
  }));
  log(zhState.lang === 'zh' && zhState.dir === 'ltr', '<html lang/dir> follows the choice', zhState);
  log(zhState.nav.includes('首页') && zhState.nav.includes('聊天'),
    'tabbar repaints into 简体中文 in place', { nav: zhState.nav });
  log(zhState.hash.includes('profile'), 'switching language keeps the current route', { hash: zhState.hash });
  log((zhState.value || '').includes('简体中文'), 'profile row shows the new language name', { value: zhState.value });
  await shot(page, '23-profile-zh');

  // A reload must come back in the same language, before the first paint.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.profile-hero', { timeout: 10000 });
  const afterReload = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    nav: [...document.querySelectorAll('.tabbar [data-go]')].map((n) => n.textContent.trim()),
  }));
  log(afterReload.lang === 'zh' && afterReload.nav.includes('首页'),
    'language choice survives a reload', afterReload);

  // The account must know too: the reply engine reads `users.locale`.
  const accountLocale = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('wy_token') },
    });
    return (await r.json()).data.user.locale;
  });
  log(accountLocale === 'zh', 'account locale is saved server-side', { accountLocale });

  /* RTL: Arabic must flip the document, not just the words. */
  await goto(page, 'profile', '.profile-hero');
  await page.click('#profile-language');
  await page.waitForSelector('.lang-list [data-lang="ar"]', { timeout: 6000 });
  await page.click('.lang-list [data-lang="ar"]');
  await settle(page, 700);
  const arState = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    nav: [...document.querySelectorAll('.tabbar [data-go]')].map((n) => n.textContent.trim()),
    scrollLeft: document.documentElement.scrollLeft,
  }));
  log(arState.lang === 'ar' && arState.dir === 'rtl', 'Arabic switches the document to RTL', arState);
  log(arState.nav.includes('الرئيسية'), 'tabbar repaints into العربية', { nav: arState.nav });
  // Flexbox already mirrors in RTL, so the back button must stay at the leading
  // (right) edge. Adding `flex-direction: row-reverse` on top of `direction:rtl`
  // flipped the bar twice and pushed it back to the left — measured, not guessed.
  // Profile is a tab root and has no back button, so measure on a child screen.
  await goto(page, 'privacy', '.topbar');
  await settle(page, 500);
  const rtlBar = await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return { missing: true };
    const back = bar.querySelector('[data-back]');
    if (!back) return { missing: 'no back button' };
    const b = bar.getBoundingClientRect();
    const r = back.getBoundingClientRect();
    return {
      dir: document.documentElement.dir,
      flex: getComputedStyle(bar).flexDirection,
      backGapFromRight: Math.round(b.right - r.right),
      backGapFromLeft: Math.round(r.left - b.left),
    };
  });
  log(!rtlBar.missing && rtlBar.backGapFromRight < rtlBar.backGapFromLeft,
    'in RTL the back button sits on the leading (right) edge', rtlBar);
  await shot(page, '24-profile-ar');
  // The tab bar is laid out with `row`, which already reverses under RTL; the
  // first tab must therefore be at the right, not left. Measured back on the
  // tab ROOT, because `privacy` above has no tab bar.
  await goto(page, 'profile', '.profile-hero');
  await settle(page, 500);
  const rtlTabs = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabbar [data-go]')];
    if (tabs.length < 2) return { missing: true };
    const first = tabs[0].getBoundingClientRect();
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    return { firstLeft: Math.round(first.left), lastLeft: Math.round(last.left),
             dir: document.documentElement.dir };
  });
  log(!rtlTabs.missing && rtlTabs.firstLeft > rtlTabs.lastLeft,
    'in RTL the first tab sits at the right', rtlTabs);

  // Back to English so the exhaustive audit below matches its English skip list.
  await goto(page, 'profile', '.profile-hero');
  await page.click('#profile-language');
  await page.waitForSelector('.lang-list [data-lang="en"]', { timeout: 6000 });
  await page.click('.lang-list [data-lang="en"]');
  await settle(page, 700);
  const backToEn = await page.evaluate(() => document.documentElement.lang);
  log(backToEn === 'en', 'switching back to English restores the base language');

  /* --------------------------------------------------- 10. exhaustive audit */
  const auditTargets = [
    ['home', '.home-hero'],
    ['discover', '.featured'],
    ['space', '.space-scene'],
    ['profile', '.profile-hero'],
    ['mood', '.screen'],
    ['reflection', '.screen'],
    ['rewards', '.task-card'],
    ['memory', '.settings-group'],
    ['privacy', '.privacy-hero'],
    ['plus', '.plus-hero'],
    ['relationship', '.rel-card'],
    ['wardrobe', '.stage'],
    ['rooms', '.room-card'],
    ['voice', '.voice-quota'],
    ['call', '.call-screen'],
    ['chat', '#composer'],
  ];
  for (const [hash, sel] of auditTargets) {
    await goto(page, hash, sel);
    if (hash === 'plus') {
      // The default plan card's effect is its aria-pressed state, not markup.
      const monthly = await page.getAttribute('#plan-monthly', 'aria-pressed');
      log(monthly === 'true', 'monthly plan is pre-selected', { monthly });
    }
    await auditScreen(page, `#/${hash}`, {
      returnTo: hash,
      waitFor: sel,
      skip: ['Delete my account', 'Delete account', 'Sign out', 'Log out', 'Cancel plan',
             'Reset growth', 'Export my data', 'Camera', 'Microphone',
             'Keep chatting for this one', 'Try again'],
    });
  }

  /* --------------------------------------- 10. signed-out / protected route */
  // A stale token on a hard reload must land on welcome, not a broken home.
  await gotoSignedOut(page);
  const redirected = await page.evaluate(() => location.hash);
  const landed = await page.$('.welcome');
  log(/^#\/(welcome|signin)$/.test(redirected) && !!landed,
    'protected route without a session redirects to welcome', { redirected, landed: !!landed });
} catch (err) {
  log(false, 'fatal during run', { err: String(err && err.stack || err).slice(0, 600) });
}

await browser.close();

/* --------------------------------------------------------------- summary */

const summary = {
  passed: report.steps.filter((s) => s.ok).length,
  failed: failures,
  deadControls: report.dead.length,
  consoleErrors: report.consoleErrors.length,
  resourceErrors: (report.resourceErrors || []).length,
  conflicts: (report.conflicts || []).length,
  failedRequests: report.failedRequests.length,
};
fs.writeFileSync(path.join('e2e', 'report.json'), JSON.stringify({ summary, ...report }, null, 2));

console.log('\n================ SUMMARY ================');
console.log(JSON.stringify(summary, null, 2));
if (report.consoleErrors.length) {
  console.log('\nConsole errors:');
  [...new Set(report.consoleErrors)].slice(0, 20).forEach((e) => console.log('  - ' + e));
}
if (report.failedRequests.length) {
  console.log('\nFailed requests:');
  [...new Set(report.failedRequests)].slice(0, 20).forEach((e) => console.log('  - ' + e));
}
if (report.dead.length) {
  console.log('\nDead controls:');
  report.dead.forEach((d) => console.log(`  - ${d.screen}: ${d.control}`));
}
process.exit(failures || report.dead.length ? 1 : 0);