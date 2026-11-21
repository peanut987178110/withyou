/**
 * i18n integrity check — runs on its own, no server needed.
 *
 *   node e2e/i18n-check.mjs
 *
 * Three things are asserted, because each has already broken once:
 *
 *  1. **Parity.** Every locale dictionary has the same keys, in the same order,
 *     with the same `{placeholders}`. A missing key is not a crash — `t()` falls
 *     back to English — which is exactly why it needs a test: the screen just
 *     silently reverts to English and nobody notices.
 *  2. **Coverage of dynamic families.** Keys built as `region.${code}`,
 *     `outfit.${id}`, `level.${n}` … are invisible to a plain key diff, so the
 *     families the UI indexes into are checked explicitly.
 *  3. **Error-code coverage.** Every code the server or client can emit has an
 *     `apiError.<CODE>` entry. Without this, the toast/oral error path — the one
 *     place users are already confused — is the one place that stays English.
 *
 * Exit code is non-zero on any problem, so it can gate a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE = 'en';
const LOCALES = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ar'];

/* Families the screens index into by id. Listed here so a new backend row
   without a translation is a visible failure rather than a bare key. */
const DYNAMIC_FAMILIES = ['region.', 'trait.', 'moodlabel.', 'level.',
  'activity.', 'outfit.', 'rel.', 'room.'];

const load = async (code) =>
  (await import(new URL(`../web/js/i18n/${code}.js`, import.meta.url))).default;
const placeholders = (v) => (String(v).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');

let problems = 0;
const fail = (msg) => { problems += 1; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`PASS  ${msg}`);

/* ------------------------------------------------------------ 1. parity */

const en = await load(SOURCE);
const enKeys = Object.keys(en);

for (const code of LOCALES) {
  const dict = await load(code);
  const keys = Object.keys(dict);

  const missing = enKeys.filter((k) => !(k in dict));
  const extra = keys.filter((k) => !(k in en));
  const empty = keys.filter((k) => String(dict[k]).trim() === '');
  const badPlaceholders = enKeys.filter((k) => k in dict && placeholders(dict[k]) !== placeholders(en[k]));
  const misordered = JSON.stringify(keys) !== JSON.stringify(enKeys.filter((k) => k in dict));

  const name = `${code} matches ${SOURCE}`;
  if (missing.length || extra.length || empty.length || badPlaceholders.length || misordered) {
    fail(`${name}  ${JSON.stringify({
      keys: keys.length, missing, extra, empty, badPlaceholders,
      misordered: misordered ? 'order differs' : undefined,
    })}`);
  } else {
    pass(`${name}  (${keys.length} keys)`);
  }
}

/* -------------------------------------------------- 2. dynamic families */

for (const family of DYNAMIC_FAMILIES) {
  const familyKeys = enKeys.filter((k) => k.startsWith(family));
  if (!familyKeys.length) { fail(`family ${family} has no keys in ${SOURCE}`); continue; }
  const gaps = [];
  for (const code of LOCALES) {
    const dict = await load(code);
    const miss = familyKeys.filter((k) => !(k in dict));
    if (miss.length) gaps.push(`${code}: ${miss.join(' ')}`);
  }
  if (gaps.length) fail(`family ${family} incomplete — ${gaps.join(' | ')}`);
  else pass(`family ${family} covered in every locale  (${familyKeys.length} keys)`);
}

/* ------------------------------------------------- 3. error-code coverage */

const pyFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); }
    else if (e.name.endsWith('.py')) pyFiles.push(p);
  }
})(path.join(ROOT, 'backend/app'));

const codes = new Set();
for (const f of pyFiles) {
  const src = fs.readFileSync(f, 'utf8');
  // ApiError(400, "CODE", …) from any router or service.
  for (const m of src.matchAll(/ApiError\(\s*\d{3}\s*,\s*"([A-Z_]+)"/g)) codes.add(m[1]);
  // The catch-all 500 handler builds its body by hand.
  for (const m of src.matchAll(/"code":\s*"([A-Z_]+)"/g)) codes.add(m[1]);
}
const apiJs = fs.readFileSync(path.join(ROOT, 'web/js/api.js'), 'utf8');
for (const m of apiJs.matchAll(/ApiFailure\(\s*\d+\s*,\s*'([A-Z_]+)'/g)) codes.add(m[1]);
// `'HTTP_' + status` for a non-JSON error body → one generic key covers them all.
if (/'HTTP_' \+/.test(apiJs)) codes.add('HTTP_GENERIC');

const untranslated = [...codes].filter((c) => !(`apiError.${c}` in en));
if (untranslated.length) fail(`error codes without an apiError.* key — ${untranslated.join(' ')}`);
else pass(`all ${codes.size} server/client error codes have an apiError.* key`);

const codeGaps = [];
for (const code of LOCALES) {
  const dict = await load(code);
  const miss = [...codes].filter((c) => !(`apiError.${c}` in dict));
  if (miss.length) codeGaps.push(`${code}: ${miss.join(' ')}`);
}
if (codeGaps.length) fail(`error codes missing from locales — ${codeGaps.join(' | ')}`);
else pass('error codes translated in every locale');

/* ----------------------------------------------------------------- end */

console.log(problems === 0
  ? `\nI18N OK — ${LOCALES.length + 1} locales, ${enKeys.length} keys, ${codes.size} error codes`
  : `\nI18N FAIL — ${problems} problem(s)`);
process.exitCode = problems === 0 ? 0 : 1;