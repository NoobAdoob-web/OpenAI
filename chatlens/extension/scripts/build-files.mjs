import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_DIR = '.output/chrome-mv3';

export function builtFiles(dir = BUILD_DIR) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(builtFiles(p));
    else if (/\.(js|html|json|css)$/.test(name)) out.push({ path: p, text: readFileSync(p, 'utf8') });
  }
  return out;
}
