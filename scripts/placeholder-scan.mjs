/* One-off: does every t()/tf() call supply the placeholders its key declares?
 * Not part of the suite — the i18n gate only proves keys exist in all locales. */
import fs from 'node:fs';
import path from 'node:path';

const { default: DICT } = await import('file:///F:/withyou/web/js/i18n/en.js');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !p.includes('i18n')) out.push(p);
  }
  return out;
}

let problems = 0;
for (const file of walk('F:/withyou/web/js')) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /\b(t|tf)\(\s*'([\w.]+)'/g;
  for (const m of text.matchAll(re)) {
    const [head, fn, key] = m;
    const want = new Set([...(DICT[key] || '').matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
    if (!want.size) continue;
    // Look at the argument list after the key: (…) up to the matching paren.
    let i = text.indexOf('(', m.index) + 1;
    let depth = 1;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const args = text.slice(start, i - 1);
    const have = new Set([...args.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*[:,}]/g)].map((x) => x[1]));
    // Shorthand `{ name }` form.
    for (const r of args.matchAll(/\{([^{}]*)\}/g)) {
      for (const part of r[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) have.add(name);
      }
    }
    const missing = [...want].filter((w) => !have.has(w));
    if (missing.length) {
      problems += 1;
      const line = text.slice(0, m.index).split('\n').length;
      console.log(`MISSING ${missing.join(',')}  ${path.basename(file)}:${line}  ${key}`);
    }
  }
}
console.log(`${problems} placeholder problem(s)`);