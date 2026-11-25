/** Bundle the main process, the preload script and the UI into dist/. */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, sourcemap: true, target: 'chrome140', logLevel: 'warning' } as const;

await build({ ...common, entryPoints: [join(root, 'app/main/main.ts')], outfile: join(root, 'dist/main/main.cjs'), platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
// A sandboxed preload may load only `electron`, so everything else is bundled in.
await build({ ...common, entryPoints: [join(root, 'app/preload/chrome.ts')], outfile: join(root, 'dist/preload/chrome.cjs'), platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: [join(root, 'app/ui/chrome.ts')], outfile: join(root, 'dist/ui/chrome.js'), platform: 'browser', format: 'iife', sourcemap: false });
mkdirSync(join(root, 'dist/ui'), { recursive: true });
for (const f of ['index.html', 'chrome.css']) cpSync(join(root, 'app/ui', f), join(root, 'dist/ui', f));
console.log('build: dist/main, dist/preload, dist/ui');
