/**
 * Reproduce the "three messages in a row" scenario and check the geometric
 * ordering of the resulting bubbles.
 *
 *   node e2e/probe-interleave.mjs
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE + '/#/signin', { waitUntil: 'networkidle' });
await page.fill('#email', 'alex@withyou.demo');
await page.fill('#password', 'demo1234');
await page.click('button[type="submit"]');
await page.waitForFunction(() => location.hash.includes('home') || location.hash.includes('chat'), { timeout: 15000 });
await page.evaluate(() => { location.hash = '#/chat'; });
await page.waitForSelector('#composer-input', { timeout: 15000 });
await page.waitForTimeout(1200);

const before = await page.evaluate(() => document.querySelectorAll('.msg').length);
console.log('messages before:', before);

// Three sends back-to-back, the way the screenshot was produced: type, Enter,
// type, Enter, type, Enter — no waiting for any reply.
for (const text of ['今天过得好长。', '你记得什么？', '你好']) {
  await page.fill('#composer-input', text);
  await page.press('#composer-input', 'Enter');
  await page.waitForTimeout(160);
}

await page.waitForTimeout(400);
const mid = await page.evaluate(() => [...document.querySelectorAll('#chat-body .msg')]
  .map((n) => ({ cls: n.className, mid: n.dataset.mid || '', status: n.dataset.status || '',
                 text: n.querySelector('.bubble').textContent.trim().slice(0, 28) })));
console.log('DURING:\n' + mid.map((m) => `  ${m.cls.padEnd(26)} ${m.status.padEnd(11)} ${m.text}`).join('\n'));

await page.waitForFunction(() => !document.querySelector('#chat-body .typing'), { timeout: 40000 });
await page.waitForTimeout(800);

const after = await page.evaluate(() => [...document.querySelectorAll('#chat-body .msg')]
  .map((n) => ({ cls: n.className, mid: n.dataset.mid || '', status: n.dataset.status || '',
                 text: n.querySelector('.bubble').textContent.trim().slice(0, 28) })));
console.log('\nAFTER:\n' + after.map((m) => `  ${m.cls.padEnd(26)} ${m.status.padEnd(11)} ${m.text}`).join('\n'));

// The last six nodes must alternate user/assistant: each question immediately
// followed by its own answer.
const tail = after.slice(-6).map((m) => (m.cls.includes('me') ? 'U' : 'A')).join('');
console.log('\ntail pattern:', tail);
const ok = /^(UA){3}$/.test(tail);
console.log(ok ? 'PASS ordering — every question is followed by its own reply'
  : 'FAIL ordering — replies are not attached to their questions');
if (errors.length) console.log('\nconsole errors:', errors.slice(0, 5));

await page.screenshot({ path: 'screenshots/probe-interleave.png' });
await browser.close();
process.exit(ok ? 0 : 1);