/**
 * Visual sanity for the voice surface at phone width, in both directions.
 *
 *   node e2e/probe-voice-rtl.mjs
 *
 * The E2E suites assert behaviour ("the call ends into a receipt"). This one
 * asserts that the new screens *fit*: nothing overflows the viewport
 * horizontally, no label is clipped by its container, and in RTL the back
 * control is on the right. Screenshots land in `screenshots/` so a human can
 * look at what the numbers describe.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
function check(ok, msg, extra) {
  results.push({ ok, msg, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + JSON.stringify(extra) : ''}`);
}

await page.goto(BASE + '/#/signin', { waitUntil: 'networkidle' });
await page.fill('#email', 'alex@withyou.demo');
await page.fill('#password', 'demo1234');
await page.click('button[type="submit"]');
await page.waitForFunction(() => location.hash.includes('home') || location.hash.includes('chat'), { timeout: 20000 });

/** Everything that can be measured on any screen without touching its data. */
const measure = () => page.evaluate(() => {
  const app = document.getElementById('app');
  const doc = document.documentElement;
  // Horizontal overflow: the page itself, and any child wider than its parent.
  const wide = [...app.querySelectorAll('*')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
  }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
  // Text clipped by an ancestor's fixed height (the classic ellipsis-that-ate-a-line).
  const clipped = [...app.querySelectorAll('.lang-sample, .lang-name, .voice-left, .call-line')]
    .filter((el) => el.scrollHeight > el.clientHeight + 2)
    .map((el) => `${el.className}:${el.scrollHeight}/${el.clientHeight}`);
  return {
    dir: doc.getAttribute('dir'), lang: doc.getAttribute('lang'),
    scrollW: doc.scrollWidth, innerW: window.innerWidth,
    wide, clipped,
  };
});

async function locale(code) {
  // Drive the real picker, the way a user would — there is no test-only hook,
  // and a hook would be exactly the layer that hides a broken picker.
  await page.evaluate(() => { location.hash = '#/profile'; });
  await page.waitForSelector('#profile-language', { timeout: 15000 });
  await page.click('#profile-language');
  await page.waitForSelector('.lang-list', { timeout: 5000 });
  await page.click(`[data-lang="${code}"]`);
  await page.waitForTimeout(800);
}

/* ---------------------------------------------------------------- English */
/** Clear any toast before measuring: a lingering "language changed" bubble sits
 *  over the composer and would be captured as if it were part of the screen. */
async function quiet() {
  await page.waitForFunction(() => !document.querySelector('#toasts .toast:not(.out)'),
    { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(250);
}

/** Dial the way a user does: Voice page → Start call. Setting `#/call` directly
 *  is not equivalent — once a call has ended, that route legitimately resumes
 *  the receipt (Back from the chat lands there), so the probe would be
 *  measuring the previous call instead of dialling a new one. */
async function dial() {
  await page.evaluate(() => { location.hash = '#/voice'; });
  await page.waitForSelector('#voice-start', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.click('#voice-start');
  await page.waitForSelector('.call-screen', { timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#call-elapsed');
    return el && el.textContent !== '0:00';
  }, { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(400);
  await quiet();
}

await page.evaluate(() => { location.hash = '#/voice'; });
await page.waitForSelector('.voice-quota', { timeout: 15000 });
await page.waitForTimeout(700);
await quiet();
let m = await measure();
check(m.scrollW <= m.innerW + 1, 'voice (en) has no horizontal overflow', { scrollW: m.scrollW, innerW: m.innerW });
check(m.wide.length === 0, 'voice (en) has no element past the viewport edge', { wide: m.wide });
check(m.clipped.length === 0, 'voice (en) clips no label', { clipped: m.clipped });
await page.screenshot({ path: 'screenshots/probe-voice-en.png', fullPage: false });

await dial();
m = await measure();
check(m.scrollW <= m.innerW + 1, 'call (en) has no horizontal overflow', { scrollW: m.scrollW });
check(m.wide.length === 0, 'call (en) has no element past the viewport edge', { wide: m.wide });
const topEn = await page.textContent('#call-top-label');
check(!/calling/i.test(topEn || ''), 'call (en) header is live, not ringing', { topEn });
await page.screenshot({ path: 'screenshots/probe-call-en.png' });
await page.click('[data-end]');
await page.waitForSelector('#call-detail-cta', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(500);
m = await measure();
check(m.scrollW <= m.innerW + 1, 'call receipt (en) has no horizontal overflow', { scrollW: m.scrollW });
await page.screenshot({ path: 'screenshots/probe-call-receipt-en.png' });

/* --------------------------------------------------------------- Arabic */
await locale('ar');
m = await measure();
check(m.dir === 'rtl' && m.lang === 'ar', 'document flipped to Arabic RTL', { dir: m.dir, lang: m.lang });

await page.evaluate(() => { location.hash = '#/voice'; });
await page.waitForSelector('.voice-quota', { timeout: 15000 });
await page.waitForTimeout(800);
m = await measure();
check(m.scrollW <= m.innerW + 1, 'voice (ar) has no horizontal overflow', { scrollW: m.scrollW });
check(m.wide.length === 0, 'voice (ar) has no element past the viewport edge', { wide: m.wide });
const backAr = await page.evaluate(() => {
  const b = document.querySelector('.topbar .back, .topbar button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { fromLeft: Math.round(r.left), fromRight: Math.round(window.innerWidth - r.right) };
});
check(backAr && backAr.fromRight < backAr.fromLeft, 'voice (ar) back control sits on the right', { backAr });
const rulesAr = await page.evaluate(() => [...document.querySelectorAll('.voice-rules li')]
  .map((el) => el.getBoundingClientRect().height > 0));
check(rulesAr.length === 4 && rulesAr.every(Boolean), 'voice (ar) renders all four rules', { rulesAr });
await page.screenshot({ path: 'screenshots/probe-voice-ar.png', fullPage: false });

await dial();
m = await measure();
check(m.scrollW <= m.innerW + 1, 'call (ar) has no horizontal overflow', { scrollW: m.scrollW });
check(m.wide.length === 0, 'call (ar) has no element past the viewport edge', { wide: m.wide });
await page.screenshot({ path: 'screenshots/probe-call-ar.png' });
await page.click('[data-end]');
await page.waitForSelector('#call-detail-cta', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/probe-call-receipt-ar.png' });

/* Dialling again from Voice must reach a live call, not the receipt above. */
await page.evaluate(() => { location.hash = '#/voice'; });
await page.waitForSelector('.voice-quota', { timeout: 15000 });
await page.click('#voice-start');
await page.waitForSelector('.call-screen', { timeout: 15000 });
await page.waitForFunction(() => {
  const el = document.querySelector('#call-elapsed');
  return el && el.textContent !== '0:00';
}, { timeout: 20000 }).catch(() => null);
const again = await page.evaluate(() => ({
  cta: !!document.querySelector('#call-detail-cta'),
  end: !!document.querySelector('[data-end]'),
  label: (document.querySelector('#call-top-label') || {}).textContent || '',
}));
check(again.end && !again.cta && !/ended/i.test(again.label),
  'start call after a call dials again (ar)', again);
await page.screenshot({ path: 'screenshots/probe-call-ar-again.png' });

check(errors.length === 0, 'no console errors while probing', { errors: errors.slice(0, 4) });

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
await browser.close();
process.exit(failed.length ? 1 : 0);