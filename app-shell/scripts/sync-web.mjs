// 从 ../web 同步前端到 www，并把 ../backend/app(代码) + ../backend/kb(知识库)
// 整目录覆盖进 APK 的 python 源码目录。
//
// 单一来源原则：APK 里跑的后端必须就是测过的那份 backend/app。
// 手工拷贝很容易出现"改了后端但 App 里还是旧逻辑，而且没有任何报错"。
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, '..', 'web');
const dst = join(root, 'www');

// ---------------------------------------------------------------- web 前端
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const dir of ['css', 'js']) {
  cpSync(join(src, dir), join(dst, dir), { recursive: true });
}
for (const file of ['index.html', 'manifest.webmanifest', 'icon.svg']) {
  const from = join(src, file);
  if (existsSync(from)) cpSync(from, join(dst, file));
}

let html = readFileSync(join(src, 'index.html'), 'utf8');
// 壳内的后端地址固定为本机 Chaquopy 服务；web 版留空表示同源。
html = html.replace(
  '<meta name="wy-api" content="">',
  '<meta name="wy-api" content="">\n<meta name="wy-api-default" content="http://127.0.0.1:8791/api/v1">',
);
writeFileSync(join(dst, 'index.html'), html);
console.log('www synced from ../web');

// ------------------------------------------------------- 后端 Python 源码
const pyRoot = join(root, 'android', 'app', 'src', 'main', 'python');
const pySrc = join(root, '..', 'backend');
const pyDst = join(pyRoot, 'app');
if (existsSync(join(pySrc, 'app'))) {
  rmSync(pyDst, { recursive: true, force: true });
  cpSync(join(pySrc, 'app'), pyDst, {
    recursive: true,
    filter: (s) => !s.includes('__pycache__'),
  });
  // kb.json 用 `parent.parent / "kb"` 定位，即 python/kb/kb.json
  const kbSrc = join(pySrc, 'kb');
  const kbDst = join(pyRoot, 'kb');
  if (existsSync(kbSrc)) {
    rmSync(kbDst, { recursive: true, force: true });
    cpSync(kbSrc, kbDst, { recursive: true });
  }
  console.log('backend/app + backend/kb synced into android/src/main/python');
} else {
  console.warn('WARN: 找不到 ../backend/app，APK 里的后端不会被更新');
}

// 静态前端在 APK 里由 Capacitor 的 assets 提供，后端的 StaticFiles 挂载
// 在 `__file__.parent.parent.parent / "web"` —— 设备上不存在，会自然跳过。