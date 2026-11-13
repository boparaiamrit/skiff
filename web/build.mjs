import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
const out = '../server/dist';
mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: { app: 'src/main.js', assist: 'src/assist.js' },
  bundle: true, minify: true, sourcemap: false, format: 'iife', target: ['chrome100'],
  outdir: out, loader: { '.css': 'css' }, logLevel: 'warning',
});
copyFileSync('index.html', out + '/index.html');
copyFileSync('assist.html', out + '/assist.html');
console.log('built');
