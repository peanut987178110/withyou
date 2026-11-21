/**
 * 极小的 Chrome DevTools Protocol 客户端，专门用来驱动 Android WebView。
 *
 * 为什么不用 Playwright 的 connectOverCDP：它按"整个浏览器"建模（要先建
 * BrowserContext、设下载行为），而 WebView 的 devtools 端点只有页面级
 * target，调用 Browser.* 会直接报
 *   Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.
 *
 * 这里用 Node 22 自带的全局 WebSocket 直接说协议。点击走
 * Input.dispatchTouchEvent —— 和手指按下去是同一条输入管线（浏览器自己合成
 * click、触发 :active、走命中测试），而不是 JS 里 element.click()。
 */

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error('cdp connect failed: ' + (e.message || e.type)));
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const fns = listeners.get(msg.method);
    if (fns) for (const fn of fns) { try { fn(msg.params); } catch { /* 监听器出错不影响主流程 */ } }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const errors = [];
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (/Failed to load resource/.test(text)) return;   // SSE 主动断开属于预期
    errors.push(text);
  });
  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push(d.exception?.description || d.text || 'uncaught exception');
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable').catch(() => {});

  /** 在页面里跑一段表达式，返回值按 JSON 回传。 */
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + (d.exception?.description || d.text));
    }
    return r.result?.value;
  }

  /** 元素中心点（CSS 像素，视口坐标）。 */
  async function center(selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`not visible: ${selector}`);
    return box;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 真实触摸点击：touchStart → touchEnd，浏览器自己合成 click。
   *
   * 坐标必须"测完就点"，中间不能有任何一次布局变化 —— 而 Android 上最容易变的就是
   * 软键盘：它把布局视口从 839 直接压到 527，聊天页的 #chat-body 只剩两百多像素，
   * 之前算好的点会落到输入框上，点击就被吃掉了。所以：
   *   1. 先把焦点交出去（收键盘），
   *   2. 在同一次页面执行里 scrollIntoView + 等两帧 + 测量，
   *   3. 元素中心被挡住时，在元素内部采样若干个点，挑第一个真正能命中的
   *      —— 真人也是点能看见的那一块，而不是硬戳中心。
   * 都失败才抛错，并且报出挡住它的元素，方便定位是遮罩还是滚不动。
   */
  async function tap(selector, { settle = 260, scroll = true, tries = 3 } = {}) {
    let geo = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      geo = await evaluate(`(async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { err: 'missing' };
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        /* 等布局真的停下来。
         *
         * 收起键盘不是瞬间完成的：visualViewport 会连着几十帧持续变大，按钮跟着
         * 往下走。只等两帧就测坐标的话，测完的那一刻是对的，等到 dispatchTouchEvent
         * 真正发出去（一次 CDP 往返，几十毫秒）时按钮已经移开了 —— 点击落在空白处，
         * 表现成"点了没反应"，而且命中测试还查不出来。所以这里等到连续三帧
         * 视口高度不再变化为止（最多 900ms）。 */
        const settled = async () => {
          let last = -1, same = 0;
          const t0 = Date.now();
          while (Date.now() - t0 < 900) {
            const h = Math.round(visualViewport ? visualViewport.height : innerHeight);
            same = h === last ? same + 1 : 0;
            last = h;
            if (same >= 3) return;
            await raf();
          }
        };
        const a = document.activeElement;
        if (a && a !== document.body && a.blur) a.blur();
        await settled();
        if (${scroll}) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); await raf(); await settled(); }
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { err: 'zero-size' };
        const vw = (window.visualViewport && visualViewport.width) || innerWidth;
        const vh = (window.visualViewport && visualViewport.height) || innerHeight;
        const own = (n) => !!n && (n === el || el.contains(n));
        // 中心优先，然后上下偏移、左右偏移 —— 都是元素内部真实存在的点
        const fx = [0.5, 0.5, 0.5, 0.5, 0.3, 0.7, 0.5, 0.5];
        const fy = [0.5, 0.3, 0.7, 0.2, 0.5, 0.5, 0.35, 0.65];
        for (let i = 0; i < fx.length; i++) {
          const x = r.x + r.width * fx[i];
          const y = r.y + r.height * fy[i];
          if (x < 0 || y < 0 || x > vw || y > vh) continue;   // 视口外的点不点
          if (own(document.elementFromPoint(x, y))) {
            return { x, y, ok: true, vh, try: ${attempt} };
          }
        }
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return {
          x: cx, y: cy, ok: false, vh,
          top: top ? (top.id || top.className || top.tagName) : null,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()`);
      if (geo.err) throw new Error(`${geo.err}: ${selector}`);
      if (geo.ok) break;
      if (attempt < tries) await sleep(320);   // 给键盘收起动画 / 列表重排一点时间，再试一次
    }
    if (!geo.ok) {
      throw new Error(
        `tap blocked on ${selector} at (${Math.round(geo.x)},${Math.round(geo.y)}) ` +
        `rect ${JSON.stringify(geo.rect)}: top element is "${geo.top}", visual height ${geo.vh}`,
      );
    }
    const { x, y } = geo;
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
    });
    await sleep(45);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    if (settle) await sleep(settle);
  }

  /** 真实输入：先聚焦控件，再走 IME 通道插入文字。 */
  async function type(selector, text) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        // 清空既有内容，和手指全选删除等价
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
    if (text) await send('Input.insertText', { text });
    await new Promise((r) => setTimeout(r, 160));
  }

  /** select 没办法靠触摸选：直接设值并派发 change（与用户选择后的结果一致）。 */
  async function select(selector, value) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 200));
  }

  async function waitFor(expression, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(`!!(${expression})`)) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }

  async function screenshot(file) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const fs = await import('node:fs');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  return { ws, send, on, evaluate, tap, type, select, waitFor, screenshot, errors, close: () => ws.close() };
}

/** 列出该 devtools 端口上的页面 target。 */
export async function listTargets(httpBase) {
  const res = await fetch(`${httpBase}/json/list`);
  return res.json();
}