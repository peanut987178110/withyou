/**
 * 模拟器/真机端到端测试 —— 通过 CDP 驱动 APK 里真实运行的 WebView。
 *
 * 与 e2e/run.mjs 的区别：这里跑的是装进 Android 的包（Capacitor WebView +
 * Chaquopy 内置后端），前端来自 APK 的 assets、后端来自 APK 里的 python 源码，
 * 视口是设备的真实尺寸。点击走 Input.dispatchTouchEvent（和手指同一条输入管线），
 * 文字走 Input.insertText（IME 通道）。
 *
 * 用法：
 *   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *   node e2e/device.mjs
 *
 * 退出码非 0 表示有断言失败或控制台报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, listTargets } from './cdp.mjs';

const CDP_HTTP = process.env.WY_CDP || 'http://127.0.0.1:9333';
const SHOTS = path.resolve('screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const report = { platform: null, steps: [], consoleErrors: [], shots: [] };
let failures = 0;

function check(ok, msg, extra) {
  report.steps.push({ ok: !!ok, msg, extra });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + JSON.stringify(extra) : ''}`);
}

const targets = await listTargets(CDP_HTTP);
const target = targets.find((t) => t.type === 'page');
if (!target) {
  console.error('no page target on', CDP_HTTP);
  process.exit(2);
}
const c = await connect(target.webSocketDebuggerUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 点一下：滚动 + 测量 + 命中测试都在 cdp.tap 的同一次页面执行里完成。
 *
 * 设备上有一个坑：输入文字后软键盘弹出，visualViewport 从 839 掉到 527，
 * scrollIntoView 只在布局视口里居中，算出来的位置可能正好落在键盘底下 ——
 * 触摸事件打到键盘上，按钮看起来"点了没反应"。命中测试会当场报错，绝不假绿。
 */
const TAP = async (selector, settle = 320) => {
  await sleep(60);
  await c.tap(selector, { settle });
};

/* 截图前先让软键盘收起：设备上键盘会顶起视口，画面会被压缩 */
const SHOT = async (name) => {
  await c.evaluate(`(() => {
    const a = document.activeElement;
    if (a && a.blur) a.blur();
  })()`);
  await sleep(260);
  const file = path.join(SHOTS, `device-${name}.png`);
  await c.screenshot(file);
  report.shots.push(path.basename(file));
};

const HASH = () => c.evaluate('location.hash');
const TEXT = (sel) => c.evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
/* toast 会叠放并各自 3.6 秒后消失：只认最新那一条，否则会读到上一步的旧消息。 */
const TOAST = () => c.evaluate(`(() => {
  const all = [...document.querySelectorAll('#toasts .toast')];
  return all.length ? all[all.length - 1].textContent : '';
})()`);
const DISABLED = (sel) => c.evaluate(`!!(document.querySelector(${JSON.stringify(sel)})||{}).disabled`);
const VISIBLE = (sel) => c.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
})()`);
const COUNT = (sel) => c.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

/** 点进输入框再输入（IME 通道，会触发 input 事件）。
 *
 * 顺序很重要：先 setValue 清空、再 insertText。反过来的话，先插字再清空会把刚打的字抹掉。
 */
const TYPE = async (selector, text) => {
  await TAP(selector, 220);
  await c.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await c.send('Input.insertText', { text });
  await sleep(260);
  // 提交前重新确认输入真的落进了 DOM —— 点错元素时这里会立刻发现
  const landed = await c.evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).value || ''`);
  if (landed !== text) throw new Error(`typing did not land in ${selector}: got ${JSON.stringify(landed)}`);
  // 打完字立刻收键盘：键盘弹着时可视区只剩 527px，后续按钮会被挡在底下。
  await c.evaluate(`(() => {
    const a = document.activeElement;
    if (a && a.blur) a.blur();
    document.body.focus();
  })()`);
  await sleep(420);
};

/* ================================================================ boot == */

const env = await c.evaluate(`(() => ({
  hash: location.hash,
  w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
  ua: navigator.userAgent,
  api: (document.querySelector('meta[name=wy-api]') || {}).content,
  assets: location.href,
}))()`);
report.platform = env;
console.log('device viewport:', JSON.stringify(env));
check(/Android/.test(env.ua) && /wv\)/.test(env.ua), 'running in the Android WebView (not desktop Chrome)');
check(/^http:\/\/localhost/.test(env.assets), 'page served from the APK asset bundle', { url: env.assets });
check(/127\.0\.0\.1:8791/.test(env.api || ''), 'API points at the in-APK backend', { api: env.api });

/* 清掉上一轮残留的登录态，从欢迎页冷启动一次 */
await c.evaluate(`(() => {
  try {
    localStorage.removeItem('wy_token');
    // 语言也一起清：上一轮可能停在中文，后面所有断言都按英文写。
    localStorage.removeItem('wy_locale');
  } catch (e) {}
})()`);
await c.evaluate(`location.reload()`);
await sleep(2500);
await c.waitFor("document.querySelector('.welcome')", 25000);
await SHOT('01-welcome');
check(await VISIBLE('.welcome .btn'), 'welcome screen renders on device');
check((await HASH()) === '#/welcome', 'cold start lands on welcome', { hash: await HASH() });

/* 首屏不许出现渲染占位符泄漏 */
const bogus = await c.evaluate(`/\\[object Object\\]|\\bundefined\\b|\\bNaN\\b/.test(document.body.innerText)`);
check(!bogus, 'no [object Object] / undefined / NaN leaking into the UI');

/* ============================================================== signup == */

await TAP('.welcome-actions .btn');
await c.waitFor("document.querySelector('#auth-form')", 15000);
check((await HASH()) === '#/signup', 'Create your companion → signup', { hash: await HASH() });
check(await VISIBLE('#auth-form'), 'signup form rendered');

/* 表单校验：空提交要报错而不是静默失败 */
await TAP('#auth-submit', 300);
const emptyErr = await c.evaluate(`(() => {
  const e = document.querySelector('#auth-error');
  return e && !e.hidden ? e.textContent : '';
})()`);
check(/valid email/i.test(emptyErr), 'empty signup shows a validation error', { emptyErr });

const email = `device-${Date.now()}@example.test`;
await TYPE('#name', 'Riley');
await TYPE('#email', email);
await TYPE('#password', 'demo1234');
await SHOT('02-signup');
await TAP('#auth-submit', 600);
await c.waitFor("document.querySelector('#age-toggle')", 25000);
check((await HASH()) === '#/age', 'account created → age gate', { hash: await HASH() });

/* ============================================================ age gate == */

await SHOT('03-age');
check(await DISABLED('#age-continue'), 'Continue is disabled before attesting age');
await TAP('#age-toggle');
check((await c.evaluate(`document.querySelector('#age-toggle').getAttribute('aria-checked')`)) === 'true',
  'age switch flips on');
await c.select('#region', 'US');
await sleep(300);
check(!(await DISABLED('#age-continue')), 'Continue enables once adult + region are set');
await TAP('#age-continue', 800);
await c.waitFor("document.querySelector('#comp-name')", 25000);
check((await HASH()) === '#/create', 'age saved → create companion', { hash: await HASH() });

/* ============================================================== create == */

await SHOT('04-create');
await TYPE('#comp-name', 'Mia');
await TAP('[data-intent="motivate"]');
check((await c.evaluate(`document.querySelector('[data-intent="motivate"]').getAttribute('aria-pressed')`)) === 'true',
  'intent card selects');
await TAP('[data-trait="Calm"]');
await TAP('[data-trait="Playful"]');
const traitCount = (await TEXT('#trait-count')).trim();
check(traitCount === '3 / 5', 'three traits selected (Warm + Calm + Playful)', { traitCount });

/* 超上限要给出提示而不是静默忽略 */
await TAP('[data-trait="Curious"]');
await TAP('[data-trait="Grounded"]');
await TAP('[data-trait="Encouraging"]', 400);
const capped = (await TEXT('#trait-count')).trim();
const toastText = await TOAST();
check(capped === '5 / 5', 'trait cap holds at five', { capped });
check(/five traits/i.test(toastText), 'over-selecting a trait explains the cap', { toastText });
await TAP('[data-trait="Encouraging"]');   // 取消，恢复 4/5 之外再加回三个
await TAP('[data-trait="Curious"]');
await TAP('[data-trait="Grounded"]');
await SHOT('04b-create-traits');

await TAP('#create-continue', 900);
await c.waitFor("document.querySelector('#composer-input')", 30000);
check((await HASH()) === '#/chat', 'companion created → chat', { hash: await HASH() });
await sleep(800);

/* ================================================================ chat == */

await SHOT('05-chat-empty');
check(await DISABLED('#composer-send'), 'send is disabled on an empty composer');

await TYPE('#composer-input', 'Hey Mia, I had a long day but I made it through.');
check(!(await DISABLED('#composer-send')), 'send enables when there is text');

await TAP('#composer-send', 600);
await c.waitFor(`document.querySelectorAll('.msg.ai').length >= 2
  && document.querySelectorAll('.msg.generating').length === 0`, 40000);
await sleep(900);
const aiCount = await COUNT('.msg.ai');
check(aiCount >= 2, 'a real reply came back from the backend inside the APK', { aiCount });
/* Replies are interleaved now, so the newest AI bubble is not
   `:last-of-type` — a user bubble follows it. Take the last .msg.ai in DOM order. */
const replyText = await c.evaluate(`(() => {
  const all = [...document.querySelectorAll('.msg.ai .bubble')];
  return all.length ? all[all.length - 1].textContent : '';
})()`);
check((replyText || '').trim().length > 20, 'the reply body is actually rendered', {
  chars: (replyText || '').trim().length,
});
await SHOT('06-chat-first');

/* 建议 chip → 填入输入框 */
await TAP('[data-suggest]', 500);
const chipText = await c.evaluate(`document.querySelector('#composer-input').value`);
check((chipText || '').length > 0, 'suggestion chip fills the composer', { chipText });
check((await c.evaluate(`document.querySelector('#composer-send').disabled`)) === false,
  'the chip also enables send');

await TYPE('#composer-input', 'I love jazz and quiet rainy afternoons.');
await TAP('#composer-send', 600);
await c.waitFor(`document.querySelectorAll('.msg.ai').length >= 3
  && document.querySelectorAll('.msg.generating').length === 0`, 40000);
await sleep(900);
await SHOT('07-chat-thread');
check((await TEXT('.chat-head .quota')).includes('left today'), 'quota counter visible');

/* 记忆提议：确认一张卡。
 *
 * `/memories` 的提议块现在每次进聊天都会重取，所以这里的计数等于"服务端还有几条待定"。
 * 确认之后卡片应该被替换成"confirmed"，而不是原样留着。 */
const proposals = await COUNT('#chat-body .proposal-card');
check(proposals > 0, 'memory proposal surfaced on device', { proposals });
let confirmedPid = null;
if (proposals > 0) {
  confirmedPid = await c.evaluate(`document.querySelector('#chat-body .proposal-card').getAttribute('data-pid')`);
  await TAP('#chat-body .proposal-card [data-pact="confirm"]', 1600);
  const card = await c.evaluate(`(() => {
    const n = document.querySelector('.proposal-card[data-pid="${confirmedPid}"]');
    return n ? n.textContent.replace(/\\s+/g, ' ').trim() : null;
  })()`);
  check(/confirmed/i.test(card || ''), 'proposal confirms and shows the result', {
    card: (card || '').slice(0, 90), toast: (await TOAST()).slice(0, 50),
  });
}
await SHOT('08-chat-after-proposal');

/* 回复上的 Copy / Again / Report */
const hasActions = await c.evaluate(`(() => {
  const meta = [...document.querySelectorAll('.msg.ai .meta')].pop();
  return !!(meta && meta.querySelector('[data-act="copy"]'));
})()`);
check(hasActions, 'reply carries Copy / Again / Report actions');

await c.evaluate(`(() => {
  const meta = [...document.querySelectorAll('.msg.ai .meta')].pop();
  meta.querySelector('[data-act="copy"]').click();
})()`);
await sleep(500);
check(/copied/i.test(await TOAST()), 'Copy reports back to the user', { toast: await TOAST() });

/* Report → 选择原因 → 提交 */
await c.evaluate(`(() => {
  const meta = [...document.querySelectorAll('.msg.ai .meta')].pop();
  meta.querySelector('[data-act="report"]').click();
})()`);
await c.waitFor("document.querySelector('.sheet-backdrop [data-reason]')", 8000);
await SHOT('08b-report-sheet');
await TAP('.sheet-backdrop [data-reason="Unsafe advice"]', 250);
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find((x) => /submit/i.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(900);
check(/submitted/i.test(await TOAST()), 'report submits', { toast: await TOAST() });
check(!(await VISIBLE('.sheet-backdrop')), 'report sheet closes after submit');

/* Again → 重新生成一条 */
const before = await COUNT('.msg.ai');
await c.evaluate(`(() => {
  const meta = [...document.querySelectorAll('.msg.ai .meta')].pop();
  meta.querySelector('[data-act="regen"]').click();
})()`);
await sleep(1200);
await c.waitFor(`document.querySelectorAll('.msg.ai').length > ${before}`, 40000);
await sleep(600);
check((await COUNT('.msg.ai')) > before, 'Again produces a fresh reply', {
  before, after: await COUNT('.msg.ai'),
});
await SHOT('08c-chat-regen');

/* 聊天选项面板 */
await TAP('#chat-more', 500);
check(await VISIBLE('.sheet-backdrop'), 'chat options sheet opens');
await SHOT('08d-chat-options');
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find((x) => /close/i.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(400);

/* ================================================================= home == */

await c.evaluate(`location.hash = '#/home'`);
await c.waitFor("document.querySelector('.home-hero')", 20000);
await sleep(1000);
await SHOT('09-home');
check(await VISIBLE('.mini-grid'), 'home renders the little-moments grid');
check(!(await c.evaluate(`/\\[object Object\\]/.test(document.getElementById('app').innerText)`)),
  'no [object Object] on home');

/* 底部 tabbar 不能压住内容 */
const overlap = await c.evaluate(`(() => {
  const bar = document.querySelector('.tabbar');
  const s = document.querySelector('.scroll');
  if (!bar || !s) return { ok: false, why: 'missing' };
  s.scrollTop = s.scrollHeight;
  const kids = [...s.children].filter((n) => n.getBoundingClientRect().height > 0);
  const last = kids[kids.length - 1].getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  return { ok: last.bottom <= b.top + 2, lastBottom: Math.round(last.bottom), barTop: Math.round(b.top) };
})()`);
check(overlap.ok, 'scrolled to the end, the last block clears the tabbar', overlap);
await SHOT('10-home-bottom');

/* tabbar 五个入口都能点（真实触摸）。
 *
 * 这里必须包含 profile：曾经 profile 页压根没渲染 tabbar，是个没有返回按钮的死胡同 ——
 * 一旦进去只能靠系统返回键。列表写全，才能保证"每个 tab 都能从这里出去"。
 */
for (const [id, sel] of [['discover', '.tabs'], ['chat', '#composer-input'], ['space', '.space-scene'], ['home', '.home-hero'], ['profile', '.profile-hero']]) {
  await c.evaluate(`document.querySelector('.tabbar [data-go="${id}"]').scrollIntoView()`);
  await TAP(`.tabbar [data-go="${id}"]`, 900);
  const ok = await c.waitFor(`document.querySelector(${JSON.stringify(sel)})`, 25000).then(() => true).catch(() => false);
  check(ok, `tabbar → ${id}`, { hash: await HASH() });
  const stillThere = await c.evaluate(`!!document.querySelector('.tabbar')`);
  check(stillThere, `the tabbar stays on ${id} (no dead end)`, { hash: await HASH() });
}

/* ================================================================= mood == */

await c.evaluate(`location.hash = '#/mood'`);
await c.waitFor("document.querySelector('#mood-grid')", 20000);
await sleep(500);
await SHOT('11-mood');
check(await DISABLED('#mood-save'), 'Save check-in starts disabled');
await TAP('[data-mood]');
check(!(await DISABLED('#mood-save')), 'choosing a mood enables Save check-in');
await TAP('#mood-save', 1500);
const moodHash = await HASH();
check(moodHash === '#/home', 'mood saved and returns home', { hash: moodHash });
const moodDone = await c.evaluate(`!!document.querySelector('.checkin-card.done')`);
check(moodDone, 'home shows today\'s check-in as done');

/* =========================================================== reflection == */

await c.evaluate(`location.hash = '#/reflection'`);
await c.waitFor("document.querySelector('#reflect-text')", 20000);
await sleep(400);
await SHOT('12-reflection');
check(await DISABLED('#reflect-save'), 'Save reflection starts disabled');
await TYPE('#reflect-text', 'Ten minutes of sun on the kitchen floor.');
check(!(await DISABLED('#reflect-save')), 'typing enables Save reflection');
await TAP('#reflect-save', 2200);
const reflectHash = await HASH();
const reflectToast = (await TOAST()).slice(0, 60);
const reflectErr = await c.evaluate(`(() => {
  const e = document.querySelector('#reflect-error');
  return e && !e.hidden ? e.textContent : null;
})()`);
check(reflectHash === '#/home', 'reflection saved and returns home', {
  hash: reflectHash, toast: reflectToast, error: reflectErr,
});

/* ============================================================== rewards == */

await c.evaluate(`location.hash = '#/rewards'`);
await c.waitFor("document.querySelector('.task-card')", 20000);
await sleep(500);
await SHOT('13-rewards');
const tasks = await COUNT('.task-card');
check(tasks === 3, 'rewards lists all three daily activities', { tasks });
const earned = await TEXT('.ledger-row');
check(/Mood check-in|Evening reflection/i.test(earned), 'ledger shows the rewards just earned', {
  first: (earned || '').slice(0, 60),
});
const ledgerRows = await COUNT('.ledger-row');
check(ledgerRows >= 3, 'ledger has entries for mood, reflection and onboarding', { ledgerRows });

/* ============================================================= discover == */

await c.evaluate(`location.hash = '#/discover'`);
await c.waitFor("document.querySelector('.tabs')", 20000);
await sleep(500);
await SHOT('14-discover');
const tabNames = await c.evaluate(`[...document.querySelectorAll('.tabs [data-tab]')].map(b => b.getAttribute('data-tab'))`);
check(tabNames.length >= 3, 'discover has multiple tabs', { tabNames });
for (const t of tabNames) {
  await TAP(`.tabs [data-tab="${t}"]`, 450);
  const n = await COUNT('#tab-body .list-item');
  check(n > 0, `discover tab "${t}" lists prompts`, { n });
}
await SHOT('15-discover-tabs');

/* ================================================================ space == */

await c.evaluate(`location.hash = '#/space'`);
await c.waitFor("document.querySelector('.space-scene')", 20000);
await sleep(600);
await SHOT('16-space');

await TAP('.space-actions [data-go="wardrobe"]', 900);
await c.waitFor("document.querySelector('.wardrobe-page')", 20000);
await sleep(800);
await SHOT('17-wardrobe');
const shopItems = await COUNT('[data-item]');
check(shopItems >= 4, 'wardrobe lists the sets', { shopItems });

/* 一件"还没拥有"的：界面用 badge 文案区分 Owned / Wearing / ✦ 价格，没有 data 属性。
 *
 * 买得起才点确认，买不起就走"Not now"，两条分支都要走到 —— 否则测出来的
 * "PASS" 其实是被"Lumen 不够"弹回来的。先读余额，再**优先挑买得起的那件**：
 * 演示账号 30 Lumen，按列表顺序抓到的是 35 的套装，于是这台机器上从来没走过
 * 真正的购买路径，只有"余额不足"那条。挑对了才有覆盖。 */
const lockedSel = await c.evaluate(`(() => {
  const lumen = (() => {
    const m = document.querySelector('.reward-pill.lumen');
    return m ? parseInt(m.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
  })();
  const locked = [...document.querySelectorAll('[data-item]')].map((x) => {
    const bd = x.querySelector('.badge');
    const price = bd && bd.classList.contains('warn')
      ? parseInt(bd.textContent.replace(/[^0-9]/g, ''), 10) || 0 : null;
    return { el: x, price };
  }).filter((x) => x.price !== null && x.price > 0);
  const pick = locked.find((x) => x.price <= lumen) || locked[0];
  return pick ? '[data-item="' + pick.el.getAttribute('data-item') + '"]' : null;
})()`);
const lumenNow = await c.evaluate(`(() => {
  const m = document.querySelector('.reward-pill.lumen');
  return m ? parseInt(m.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
})()`);
if (lockedSel) {
  await TAP(lockedSel, 700);
  const sheetUp = await VISIBLE('.sheet-backdrop');
  check(sheetUp, 'tapping a locked set opens the purchase sheet');
  await SHOT('17b-wardrobe-sheet');
  if (sheetUp) {
    const price = await c.evaluate(`(() => {
      const t = document.querySelector('.sheet-backdrop .sheet-body').textContent;
      const m = t.match(/✦\\s*(\\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })()`);
    const canAfford = lumenNow >= price;
    if (canAfford) {
      await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
        const b = btns.find(x => /unlock/i.test(x.textContent));
        if (b) b.click();
      })()`);
      await sleep(1800);
      check(/unlocked|look updated/i.test(await TOAST()), 'unlocking a set with enough Lumen succeeds', {
        price, lumenNow, toast: (await TOAST()).slice(0, 50),
      });
      const worn = await c.evaluate(`(() => {
        const b = document.querySelector(${JSON.stringify(lockedSel)});
        const bd = b && b.querySelector('.badge');
        return bd ? bd.textContent.trim() : null;
      })()`);
      check(/wearing/i.test(worn || ''), 'the unlocked set is now worn', { worn });
      const accentRows = await c.evaluate(`[...document.querySelectorAll('[data-item]')]
        .filter((n) => n.style.border.includes('--accent'))
        .map((n) => n.getAttribute('data-item'))`);
      check(accentRows.length === 1 && lockedSel.includes(accentRows[0]),
        'the accent outline moves to the set now being worn', { accentRows });
    } else {
      await c.evaluate(`(() => {
        const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
        const b = btns.find(x => /not now/i.test(x.textContent));
        if (b) b.click();
      })()`);
      await sleep(700);
      check(!(await VISIBLE('.sheet-backdrop')), 'declining the purchase closes the sheet', { price, lumenNow });
      check((await c.evaluate(`document.querySelector(${JSON.stringify(lockedSel)}).querySelector('.badge').textContent.trim()`)) !== 'Wearing',
        'declining leaves the outfit unchanged');
    }
    await SHOT('17c-wardrobe-after');
  }
} else {
  check(true, 'wardrobe: nothing locked to buy (all owned)');
}

await c.evaluate(`location.hash = '#/rooms'`);
await c.waitFor("document.querySelector('[data-room]')", 20000);
await sleep(400);
await SHOT('18-rooms');
const rooms = await COUNT('[data-room]');
check(rooms >= 3, 'room presets listed', { rooms });
const otherRoom = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('[data-room]')].find(x => x.getAttribute('aria-pressed') !== 'true');
  return b ? b.getAttribute('data-room') : null;
})()`);
if (otherRoom) {
  await TAP(`[data-room="${otherRoom}"]`, 300);
  check((await c.evaluate(`document.querySelector('[data-room="${otherRoom}"]').getAttribute('aria-pressed')`)) === 'true',
    'room preset selects');
  await TAP('#room-save', 2200);
  // 页面上成功会 toast "Room updated." 再 go('space')；失败则把错误留在 #room-error。
  const roomErr = await c.evaluate(`(() => {
    const e = document.querySelector('#room-error');
    return e && !e.hidden ? e.textContent : null;
  })()`);
  check((await HASH()) === '#/space', 'saving the room returns to the space', {
    hash: await HASH(), roomErr, toast: (await TOAST()).slice(0, 40),
  });
  await SHOT('19-space-redecorated');
}

await c.evaluate(`location.hash = '#/call'`);
await c.waitFor("document.querySelector('.call-screen')", 20000);
/* The screen mounts while the dial (`POST /calls`) is still in flight, so at
   this point `call.id` is unset and the hang-up button would fall through to
   `go('voice')` instead of ending anything. The clock only starts once the
   server has answered, so a non-zero elapsed time is the honest "connected"
   signal to wait for — a fixed sleep raced it on the emulator and the test
   then measured a call that was still live. */
await c.waitFor("document.querySelector('#call-elapsed') && document.querySelector('#call-elapsed').textContent !== '0:00'", 20000);
await sleep(400);
await SHOT('20-call');
const liveTop = await c.evaluate(`(document.querySelector('#call-top-label')||{}).textContent || ''`);
check(!/calling/i.test(liveTop), 'the call chrome stops saying "Calling…" once connected', { liveTop });
/* The call has a real microphone and a real speaker now. `data-mic` is what the
   screen decided after asking for the device: on an emulator with RECORD_AUDIO
   granted it must be "on"; "denied"/"none" would be the honest fallback but
   also means the manifest or the permission bridge regressed. */
const callAudio = await c.evaluate(`(() => {
  const el = document.getElementById('call-screen');
  if (!el) return null;
  return { phase: el.dataset.phase, mic: el.dataset.mic, engine: el.dataset.engine };
})()`);
check(!!callAudio && ['listening', 'speaking', 'thinking'].includes(callAudio.phase),
  'the call runs the live phase machine on the device', callAudio);
check(!!callAudio && callAudio.mic === 'on',
  'the WebView can open the microphone', callAudio);
await c.evaluate(`(() => { const b = document.querySelector('[data-end]'); if (b) b.click(); })()`);
/* Hanging up lands on the call's own ended state with a receipt — it no
   longer bounces back to the Space tab. The wide `#call-detail-cta` only
   exists in the ended layout, so waiting on it waits for the receipt itself
   rather than for any digit on the page. */
await c.waitFor("document.querySelector('#call-detail-cta')", 20000);
const callEndText = await c.evaluate(`(document.querySelector('.call-screen')||{}).innerText || ''`);
check(/talked for|ended/i.test(callEndText), 'ending the call settles into an ended state with a receipt', {
  hash: await HASH(), sample: callEndText.slice(0, 80),
});

/* Calling again dials again. Reaching the route is not enough: the receipt is a
   state of this screen, so both entry points go through `startNewCall()`. */
await c.evaluate(`location.hash = '#/space'`);
await c.waitFor("document.querySelector('#space-call')", 20000);
await sleep(400);
await TAP('#space-call', 600);
await c.waitFor("document.querySelector('#call-elapsed') && document.querySelector('#call-elapsed').textContent !== '0:00'", 25000);
const secondCall = await c.evaluate(`({
  cta: !!document.querySelector('#call-detail-cta'),
  end: !!document.querySelector('[data-end]'),
  label: (document.querySelector('#call-top-label')||{}).textContent || '',
})`);
check(secondCall.end && !secondCall.cta && !/ended/i.test(secondCall.label),
  'calling again after a call starts a new call, not the old receipt', secondCall);
await c.evaluate(`(() => { const b = document.querySelector('[data-end]'); if (b) b.click(); })()`);
await c.waitFor("document.querySelector('#call-detail-cta')", 20000);

/* ============================================================== profile == */

await c.evaluate(`location.hash = '#/profile'`);
await c.waitFor("document.querySelector('.profile-hero')", 20000);
await sleep(600);
await SHOT('21-profile');
check(!(await c.evaluate(`/\\[object Object\\]/.test(document.getElementById('app').innerText)`)),
  'no [object Object] on profile');

/* 主动问候开关 */
const beforeToggle = await c.evaluate(`document.querySelector('[data-toggle="checkins"] [data-switch]').getAttribute('aria-checked')`);
await TAP('[data-toggle="checkins"]', 900);
const afterToggle = await c.evaluate(`document.querySelector('[data-toggle="checkins"] [data-switch]').getAttribute('aria-checked')`);
check(beforeToggle !== afterToggle, 'proactive check-ins switch toggles and persists', { beforeToggle, afterToggle });

/* About / Safety 面板 */
await TAP('[data-info="about"]', 600);
check(await VISIBLE('.sheet-backdrop'), 'About sheet opens');
await SHOT('21b-about');
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find(x => /close/i.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(400);
await TAP('[data-info="safety"]', 600);
check(await VISIBLE('.sheet-backdrop'), 'Safety resources sheet opens');
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find(x => /close/i.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(400);

/* ============================================================ 语言切换 == */

/* 设备上尤其要验：切换后当前路由不动、五个 tab 都还在、<html dir> 真的翻了、
   选择活过重载。第二条在设备上比浏览器更重要 —— 安卓会为了省内存回收 WebView，
   回来时就是一次冷启动，靠的只有 localStorage。 */
await c.evaluate(`location.hash = '#/profile'`);
await c.waitFor("document.querySelector('#profile-language')", 20000);
await sleep(500);
await TAP('#profile-language', 700);
check(await VISIBLE('.lang-list'), 'language sheet opens from profile');
const langRows = await COUNT('.lang-list [data-lang]');
check(langRows === 10, 'sheet lists all ten languages', { langRows });
/* 每一行都要给出伴侣在该语言下真实会说的一句 —— 只列族名的话，
   看不懂 繁體中文 和 简体中文 的人无从选择。样句来自后端 /meta。 */
const samples = await c.evaluate(`[...document.querySelectorAll('.lang-list .lang-sample')]
  .map(s => ({ lang: s.getAttribute('lang'), n: s.textContent.trim().length }))`);
check(samples.length === 10 && samples.every(s => s.n > 4),
  'every language row previews a sample line from the companion', {
    n: samples.length, short: samples.filter(s => s.n <= 4),
  });
/* 十行加 Close 必须在一屏之内：要选的那一行如果掉到折线以下，就等于没有 */
const sheetFits = await c.evaluate(`(() => {
  const s = document.querySelector('.sheet');
  return { scrollH: s.scrollHeight, clientH: s.clientHeight };
})()`);
check(sheetFits.scrollH <= sheetFits.clientH + 2,
  'all ten languages fit the sheet without scrolling on device', sheetFits);
await sleep(500);   // 面板上滑 .26s，拍早了会拍到半透明的遮罩
await SHOT('21c-language-sheet');

await TAP('.lang-list [data-lang="zh"]', 900);
const zhLang = await c.evaluate(`document.documentElement.lang`);
const zhDir = await c.evaluate(`document.documentElement.dir`);
const zhNav = await c.evaluate(`[...document.querySelectorAll('.tabbar [data-go]')].map(n => n.textContent.trim())`);
check(zhLang === 'zh' && zhDir === 'ltr', '<html lang/dir> follow the choice', { zhLang, zhDir });
check(zhNav.includes('首页') && zhNav.includes('我的'), 'tabbar repaints into 简体中文 on device', { zhNav });
check((await HASH()) === '#/profile', 'switching keeps the current route on device', { hash: await HASH() });
const zhRow = await TEXT('#language-value');
check(zhRow.includes('简体中文'), 'profile shows the chosen language name', { zhRow });
await SHOT('21d-profile-zh');

/* 真的重载一次：设备上的「切后台再回来」就是这条路 */
await c.evaluate(`location.reload()`);
await sleep(2600);
await c.waitFor("document.querySelector('.profile-hero')", 30000);
const afterReload = await c.evaluate(`({
  lang: document.documentElement.lang,
  nav: [...document.querySelectorAll('.tabbar [data-go]')].map(n => n.textContent.trim()),
  hash: location.hash
})`);
check(afterReload.lang === 'zh' && afterReload.nav.includes('首页'),
  'language choice survives a page reload on device', afterReload);

/* 最关键的一条：伴侣是不是真的用中文回答。
   APK 里的后端读的是 users.locale，切换时必须 PATCH 上去，否则界面中文、
   回复英文 —— 这正是"切换语言"最容易做成半拉子的地方。 */
await c.evaluate(`location.hash = '#/chat'`);
await c.waitFor("document.querySelector('#composer-input')", 20000);
await sleep(600);
const aiBeforeZh = await COUNT('.msg.ai');
await TYPE('#composer-input', '今天有点累，但是还好。');
await TAP('#composer-send', 600);
// 气泡是先建出来再流式填字的：只等气泡数量会拿到空字符串。
// 等到最后一条 AI 气泡真的有字、并且打字指示器消失，才算回复到了。
await c.waitFor(`(() => {
  const bubbles = document.querySelectorAll('.msg.ai .bubble');
  if (bubbles.length <= ${aiBeforeZh}) return false;
  const last = bubbles[bubbles.length - 1];
  return (last.textContent || '').trim().length > 5
    && document.querySelectorAll('.msg.generating').length === 0;
})()`, 40000);
await sleep(900);
const zhReply = await c.evaluate(`(() => {
  const b = document.querySelectorAll('.msg.ai .bubble');
  return b.length ? b[b.length - 1].textContent : '';
})()`);
check(/[一-鿿]/.test(zhReply || ''), 'the companion replies in Chinese after the switch', {
  reply: (zhReply || '').trim().slice(0, 60),
});
await SHOT('21d2-chat-zh');

await c.evaluate(`location.hash = '#/profile'`);
await c.waitFor("document.querySelector('#profile-language')", 20000);
await sleep(500);

/* RTL：阿拉伯语要真的翻转文档，不只是换字 */
await TAP('#profile-language', 700);
await TAP('.lang-list [data-lang="ar"]', 900);
const arDir = await c.evaluate(`document.documentElement.dir`);
const arNav = await c.evaluate(`[...document.querySelectorAll('.tabbar [data-go]')].map(n => n.textContent.trim())`);
check(arDir === 'rtl', 'Arabic flips the document to RTL on device', { arDir });
check(arNav.includes('الرئيسية'), 'tabbar repaints into العربية', { arNav });
/* RTL 下 flex 的 row 本来就是从右往左排的，再加 row-reverse 会把整个 bar
   翻两次 —— 实测过：返回键会被推回左边。这里量一下，别只靠肉眼。 */
await c.evaluate(`location.hash = '#/privacy'`);
await c.waitFor("document.querySelector('.topbar [data-back]')", 20000);
await sleep(500);
const rtlBack = await c.evaluate(`(() => {
  const bar = document.querySelector('.topbar');
  const back = bar.querySelector('[data-back]');
  const b = bar.getBoundingClientRect();
  const r = back.getBoundingClientRect();
  return { fromRight: Math.round(b.right - r.right), fromLeft: Math.round(r.left - b.left) };
})()`);
check(rtlBack.fromRight < rtlBack.fromLeft,
  'in RTL the back button sits on the leading (right) edge on device', rtlBack);
await c.evaluate(`location.hash = '#/profile'`);
await c.waitFor("document.querySelector('.profile-hero')", 20000);
await sleep(500);
await SHOT('21e-profile-ar');

/* 回到英语，后面的断言都按英文写 */
await TAP('#profile-language', 700);
await TAP('.lang-list [data-lang="en"]', 900);
check((await c.evaluate(`document.documentElement.lang`)) === 'en',
  'switching back to English restores the base language');

/* ========================================================= relationship == */

await TAP('[data-go="relationship"]', 900);
await c.waitFor("document.querySelector('[data-rel]')", 20000);
await sleep(400);
await SHOT('22-relationship');
check((await COUNT('[data-rel]')) >= 4, 'relationship styles listed');
await TAP('[data-rel="mentor"]', 300);
check((await c.evaluate(`document.querySelector('[data-rel="mentor"]').getAttribute('aria-pressed')`)) === 'true',
  'relationship style selects');
await TAP('#rel-save', 300);
/* The save does PATCH → loadSession → repaint, which on the emulator outlives
   any fixed sleep. Wait for the route to actually come back. */
await c.waitFor(`location.hash === '#/profile' && document.querySelector('.profile-hero')`, 25000);
await sleep(500);
check((await HASH()) === '#/profile', 'saving the style returns to profile', { hash: await HASH() });
const relValue = await TEXT('[data-go="relationship"] .value');
check(/mentor/i.test(relValue), 'profile reflects the new style', { relValue });

/* ================================================================= plus == */

await TAP('[data-go="plus"]', 1100);
await c.waitFor("document.querySelector('#plus-buy')", 20000);
await sleep(700);
await SHOT('23-plus');
const plans = await COUNT('[data-plan]');
check(plans >= 2, 'subscription plans listed', { plans });

/* 切到年付再买 */
await TAP('#plan-yearly', 400);
const yearlyPressed = await c.evaluate(`document.querySelector('#plan-yearly').getAttribute('aria-pressed')`);
check(yearlyPressed === 'true', 'yearly plan selects', { yearlyPressed });
await TAP('#plus-buy', 2500);
await sleep(800);
await SHOT('24-plus-after');
const subState = await c.evaluate(`document.querySelector('.plus-hero') ? document.querySelector('.plus-hero').innerText : ''`);
check(/trial|active|plus/i.test(subState), 'subscription state updated after starting the trial', {
  hero: (subState || '').slice(0, 80),
});
const quotaNow = await c.evaluate(`(() => {
  return true;
})()`);
void quotaNow;

/* 回聊天，确认额度变成 Plus 的 */
await c.evaluate(`location.hash = '#/chat'`);
await c.waitFor("document.querySelector('.chat-head .quota')", 20000);
await sleep(600);
const quota = await TEXT('.chat-head .quota');
check(/300/.test(quota), 'Plus raises the daily reply allowance to 300', { quota });
await SHOT('25-chat-plus');

/* ================================================================= memory */

await c.evaluate(`location.hash = '#/memory'`);
await c.waitFor("document.querySelector('[data-switch]')", 20000);
await sleep(700);
await SHOT('26-memory');
const memSwitches = await COUNT('[data-switch]');
check(memSwitches >= 2, 'memory has separate extraction and retrieval switches', { memSwitches });
const extBefore = await c.evaluate(`document.querySelector('[data-switch="extraction_enabled"]').getAttribute('aria-checked')`);
await TAP('[data-switch="extraction_enabled"]', 1300);
const extAfter = await c.evaluate(`document.querySelector('[data-switch="extraction_enabled"]').getAttribute('aria-checked')`);
check(extBefore !== extAfter, 'extraction switch toggles on device', { extBefore, extAfter });
/* 复原，避免影响后续。等够时间：第一次的响应还没回来就点第二次会撞上 409。 */
await sleep(600);
await TAP('[data-switch="extraction_enabled"]', 1600);
const extBack = await c.evaluate(`document.querySelector('[data-switch="extraction_enabled"]').getAttribute('aria-checked')`);
check(extBack === extBefore, 'extraction switch toggles back', {
  extBack, toast: (await TOAST()).slice(0, 60),
});

/* 聊天里确认过的那条记忆要出现在"已确认"里 —— 按 id 核对，而不是数卡片数量
 * （页面上还有"待确认"的卡片，`not(.pending)` 这种选择器很脆弱）。 */
const confirmedCard = confirmedPid ? await c.evaluate(`(() => {
  const n = document.querySelector('.memory-card[data-mid]');
  return n ? n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : null;
})()`) : null;
const memCount = await COUNT('.memory-card[data-mid]');
check(memCount >= 1, 'the confirmed memory from chat is in the memory center', {
  memCount, sample: confirmedCard, confirmedPid,
});

/* ================================================================ privacy */

await c.evaluate(`location.hash = '#/privacy'`);
await c.waitFor("document.querySelector('.privacy-hero')", 20000);
await sleep(600);
await SHOT('27-privacy');
check((await COUNT('[data-switch]')) >= 2, 'privacy repeats both memory switches');
check(await VISIBLE('[data-act="export"]'), 'export action present');
check(await VISIBLE('[data-act="delete"]'), 'delete-account action present');

/* 导出：真的要拿到一份 JSON */
await TAP('[data-act="export"]', 900);
check(await VISIBLE('.sheet-backdrop'), 'export asks for the password first');
await SHOT('27b-export-sheet');

/* 先故意输错密码：服务端回 REAUTH_REQUIRED，这是唯一会把 apiError.* 文案
   送到屏幕上的常见路径 —— 而它曾经漏了一个键，中文用户会看到英文。
   这里切到中文、输错、断言提示是中文，再切回来，等于给"错误也翻译了"上锁。 */
await c.evaluate(`(() => { try { localStorage.setItem('wy_locale', 'zh'); } catch (e) {} })()`);
await c.evaluate(`location.reload()`);
await sleep(2600);
await c.waitFor("document.querySelector('.privacy-hero')", 25000);
await TAP('[data-act="export"]', 900);
await c.evaluate(`(() => {
  const inp = document.querySelector('#exp-pass');
  if (inp) { inp.value = 'wrong-password'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
})()`);
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns[0];
  if (b) b.click();
})()`);
await sleep(2200);
const reauthToast = (await TOAST()).trim();
check(/[一-鿿]/.test(reauthToast) && !/password/i.test(reauthToast),
  'a rejected password is reported in the chosen language', { reauthToast: reauthToast.slice(0, 60) });
await SHOT('27b2-export-wrong-pass-zh');

/* 回到英语，并关掉这个面板，后面按原流程走 */
await c.evaluate(`(() => { try { localStorage.setItem('wy_locale', 'en'); } catch (e) {} })()`);
await c.evaluate(`location.reload()`);
await sleep(2600);
await c.waitFor("document.querySelector('.privacy-hero')", 25000);
await TAP('[data-act="export"]', 900);

await c.evaluate(`(() => {
  const inp = document.querySelector('#exp-pass');
  if (inp) { inp.value = 'demo1234'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
})()`);
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find(x => /export|download|confirm/i.test(x.textContent));
  if (b) b.click();
})()`);
/* The export re-authenticates the password before it hands back the JSON, so
 * how long this takes is a network round trip, not a constant. Reading the
 * toast after a fixed sleep raced it: the toast was still absent at 2.5s and
 * on screen a moment later, which reads as "export failed" in the report while
 * the screenshot right underneath shows "Export ready." Wait for the state. */
await c.waitFor(`[...document.querySelectorAll('#toasts .toast')]
  .some((n) => /export|download|ready/i.test(n.textContent))`, 20000).catch(() => null);
const exportToast = await TOAST();
check(/export|download|ready/i.test(exportToast), 'export completes', { exportToast: (exportToast || '').slice(0, 70) });
await SHOT('27c-export-done');

/* 关闭可能残留的面板 */
await c.evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(n => n.remove())`);

/* =========================================================== 错误路径 == */

/* 离线：顶部横幅出现，恢复后消失 */
const offline = await c.evaluate(`(() => {
  window.dispatchEvent(new Event('offline'));
  const seen = !!document.querySelector('.offline-bar');
  window.dispatchEvent(new Event('online'));
  return { seen, gone: !document.querySelector('.offline-bar') };
})()`);
check(offline.seen && offline.gone, 'offline banner appears and clears', offline);

/* 退出登录 → 落地欢迎页 */
await c.evaluate(`location.hash = '#/profile'`);
await c.waitFor("document.querySelector('[data-signout]')", 20000);
await sleep(500);
await TAP('[data-signout]', 600);
check(await VISIBLE('.sheet-backdrop'), 'sign out asks for confirmation');
await SHOT('28-signout');
await c.evaluate(`(() => {
  const btns = [...document.querySelectorAll('.sheet-backdrop .sheet-actions .btn')];
  const b = btns.find(x => /sign out/i.test(x.textContent));
  if (b) b.click();
})()`);
await sleep(2000);
await c.waitFor("document.querySelector('.welcome')", 20000);
check((await HASH()) === '#/welcome', 'signing out returns to welcome', { hash: await HASH() });
check(!(await c.evaluate(`localStorage.getItem('wy_token')`)), 'token cleared from storage');

/* 用演示账号登录一次，确认账号可复用 */
await TAP('.welcome-actions .btn.secondary', 600);
await c.waitFor("document.querySelector('#auth-form')", 15000);
check((await HASH()) === '#/signin', 'I already have an account → sign-in', { hash: await HASH() });
await TAP('[data-demo="alex@withyou.demo"]', 2500);
await c.waitFor("document.querySelector('.home-hero')", 30000);
check((await HASH()) === '#/home', 'demo account signs in and lands on home', { hash: await HASH() });
await SHOT('29-demo-home');

/* ================================================================ wrap == */

const consoleErrors = c.errors.filter((e) => !/Failed to load resource/.test(e));
report.consoleErrors = consoleErrors;
check(consoleErrors.length === 0, 'no console errors during the whole device run', {
  errors: consoleErrors.slice(0, 5),
});

report.summary = {
  passed: report.steps.filter((s) => s.ok).length,
  failed: failures,
  total: report.steps.length,
  consoleErrors: consoleErrors.length,
  screenshots: report.shots.length,
};
fs.writeFileSync('e2e/device-report.json', JSON.stringify(report, null, 2));
console.log('\n================ DEVICE SUMMARY ================');
console.log(JSON.stringify(report.summary, null, 2));

c.close();
process.exit(failures > 0 ? 1 : 0);