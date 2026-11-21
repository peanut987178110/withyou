// 从 brand icon 生成 Android 各密度的启动图标与启动页。
// 品牌来源：web/icon.svg（淡紫底 + 月面 + 地平线弧），与网页版 favicon/PWA 图标同源。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const RES = path.resolve('android/app/src/main/res');

/* 全幅方图标（含背景），用于 legacy mipmap 与 splash */
const full = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f2ebff"/><stop offset="1" stop-color="#dfe4ff"/>
    </linearGradient>
    <radialGradient id="moon" cx="0.34" cy="0.26" r="0.8">
      <stop offset="0" stop-color="#fff9e9"/><stop offset="0.55" stop-color="#d6d8ff"/>
      <stop offset="1" stop-color="#7c81e6"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="300" cy="214" r="118" fill="url(#moon)"/>
  <path d="M-20 470c90-96 214-128 330-104 84 18 156 62 222 132v34H-20z" fill="#7c82c9" opacity=".55"/>
  <circle cx="118" cy="128" r="5" fill="#fff"/>
  <circle cx="176" cy="88" r="3" fill="#fff" opacity=".8"/>
  <circle cx="86" cy="212" r="3.5" fill="#fff" opacity=".7"/>
</svg>`;

/* 自适应图标的前景层：透明底，主体缩到安全区（中央 66%）内 */
const foreground = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="${size}" height="${size}">
  <defs>
    <radialGradient id="m" cx="0.34" cy="0.26" r="0.8">
      <stop offset="0" stop-color="#fff9e9"/><stop offset="0.55" stop-color="#d6d8ff"/>
      <stop offset="1" stop-color="#7c81e6"/>
    </radialGradient>
  </defs>
  <g transform="translate(54 54) scale(1)">
    <circle cx="2" cy="-3" r="26" fill="url(#m)"/>
    <path d="M-36 40c10-16 30-22 50-18 11 2 20 8 28 18z" fill="#7c82c9" opacity=".75"/>
    <circle cx="-16" cy="-22" r="1.8" fill="#fff"/>
    <circle cx="-25" cy="-10" r="1.2" fill="#fff" opacity=".8"/>
    <circle cx="26" cy="16" r="1.1" fill="#fff" opacity=".7"/>
  </g>
</svg>`;

/* 启动页：纯品牌纸色，中央一个小月面（Android 12 会自己裁成圆） */
const splashIcon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="${size}" height="${size}">
  <defs>
    <radialGradient id="m" cx="0.34" cy="0.26" r="0.8">
      <stop offset="0" stop-color="#fff9e9"/><stop offset="0.55" stop-color="#d6d8ff"/>
      <stop offset="1" stop-color="#7c81e6"/>
    </radialGradient>
  </defs>
  <circle cx="96" cy="96" r="62" fill="url(#m)"/>
</svg>`;

const splashBg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#f2ebff"/><stop offset="1" stop-color="#dfe4ff"/>
    </linearGradient>
    <radialGradient id="m" cx="0.34" cy="0.26" r="0.8">
      <stop offset="0" stop-color="#fff9e9"/><stop offset="0.55" stop-color="#d6d8ff"/>
      <stop offset="1" stop-color="#7c81e6"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <circle cx="${w / 2}" cy="${h * 0.42}" r="${Math.min(w, h) * 0.16}" fill="url(#m)"/>
</svg>`;

const DENSITY = {
  mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4,
};

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, out, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  console.log(`${path.basename(out)} ${w}×${h}`);
}

for (const [name, scale] of Object.entries(DENSITY)) {
  const legacy = Math.round(48 * scale);
  const fg = Math.round(108 * scale);
  const splash = Math.round(192 * scale);
  fs.mkdirSync(path.join(RES, `mipmap-${name}`), { recursive: true });
  await render(full(legacy), path.join(RES, `mipmap-${name}`, 'ic_launcher.png'), legacy, legacy);
  await render(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${legacy}" height="${legacy}"><defs><clipPath id="c"><circle cx="256" cy="256" r="256"/></clipPath></defs><g clip-path="url(#c)"><image href="data:image/svg+xml;base64,${Buffer.from(full(512)).toString('base64')}" width="512" height="512"/></g></svg>`,
    path.join(RES, `mipmap-${name}`, 'ic_launcher_round.png'), legacy, legacy);
  await render(foreground(fg), path.join(RES, `mipmap-${name}`, 'ic_launcher_foreground.png'), fg, fg);
  fs.mkdirSync(path.join(RES, `drawable-${name}`), { recursive: true });
  await render(splashIcon(splash), path.join(RES, `drawable-${name}`, 'splash_icon.png'), splash, splash);

  const port = [360, 540, 720, 1080, 1440][Object.keys(DENSITY).indexOf(name)];
  const portH = Math.round(port * 16 / 9);
  fs.mkdirSync(path.join(RES, `drawable-port-${name}`), { recursive: true });
  await render(splashBg(port, portH), path.join(RES, `drawable-port-${name}`, 'splash.png'), port, portH);

  const land = Math.round(640 * scale);
  const landH = Math.round(land * 9 / 16);
  fs.mkdirSync(path.join(RES, `drawable-land-${name}`), { recursive: true });
  await render(splashBg(land, landH), path.join(RES, `drawable-land-${name}`, 'splash.png'), land, landH);
}

await browser.close();
console.log('icons regenerated');