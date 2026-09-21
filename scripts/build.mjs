import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import archiver from 'archiver';

const root = process.cwd(), stage = resolve(root, 'build/opensearch-dashboards/betterReports');
await mkdir(stage, { recursive: true });
async function entries(dir) { const items = await readdir(dir, { withFileTypes: true }); return (await Promise.all(items.map(item => item.isDirectory() ? entries(join(dir, item.name)) : /\.ts$/.test(item.name) ? [join(dir, item.name)] : []))).flat(); }
await build({ entryPoints: [...await entries(join(root, 'server')), ...await entries(join(root, 'common'))], outbase: root, outdir: stage, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, bundle: false });
const shared = { react: 'React', 'react-dom': 'ReactDom', '@elastic/eui': 'ElasticEui' };
await build({ entryPoints: ['public/index.ts'], outfile: join(stage, 'target/public/betterReports.plugin.js'), bundle: true, platform: 'browser', target: 'es2022', format: 'iife', globalName: 'BetterReportsBundle', minify: true,
  plugins: [{ name: 'opensearch-shared-dependencies', setup(builder) {
    builder.onResolve({ filter: /^(react|react-dom|@elastic\/eui)$/ }, args => ({ path: args.path, namespace: 'osd-shared' }));
    builder.onLoad({ filter: /.*/, namespace: 'osd-shared' }, args => ({ contents: `module.exports = window.__osdSharedDeps__.${shared[args.path]};`, loader: 'js' }));
  } }],
  footer: { js: "__osdBundles__.define('plugin/betterReports/public', function(){return BetterReportsBundle;});var brCss=document.createElement('link');brCss.rel='stylesheet';brCss.href=window.__osdPublicPath__.betterReports+'betterReports.plugin.css';document.head.appendChild(brCss);" }
});
await mkdir(join(stage, 'public/assets'), { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', join(stage, 'public/assets/pdf.worker.min.mjs'));
for (const file of ['opensearch_dashboards.json', 'README.md', 'LICENSE', 'NOTICE']) await cp(file, join(stage, file));
await cp('docs', join(stage, 'docs'), { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license, dependencies: manifest.dependencies, opensearchDashboards: manifest.opensearchDashboards }, null, 2));
if (process.argv.includes('--code-only')) { console.log('Updated compiled plugin code (development only; ZIP unchanged).'); process.exit(0); }
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev || !path.startsWith('node_modules/')) continue;
  if (process.argv.includes('--repack')) {
    try {
      const staged = JSON.parse(await readFile(join(stage, path, 'package.json'), 'utf8'));
      if (staged.version !== pkg.version) throw new Error(`Staged dependency changed: ${path}. Run a full build.`);
      continue;
    } catch (error) { if (!pkg.optional || error.code !== 'ENOENT') throw error; else continue; }
  }
  try { await cp(resolve(root, path), join(stage, path), { recursive: true, filter: file => !file.endsWith('.map') }); }
  catch (error) { if (!pkg.optional || error.code !== 'ENOENT') throw error; }
}
const zipPath = resolve(root, 'build/betterReports-3.8.0.zip');
await new Promise((resolvePromise, reject) => {
  const output = createWriteStream(zipPath), archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolvePromise); output.on('error', reject); archive.on('error', reject);
  archive.pipe(output); archive.directory(stage, 'opensearch-dashboards/betterReports'); void archive.finalize();
});
const checksum = createHash('sha256').update(await readFile(zipPath)).digest('hex');
await writeFile(`${zipPath}.sha256`, `${checksum}  betterReports-3.8.0.zip\n`);
console.log(`Built ${relative(root, zipPath)}\nSHA-256 ${checksum}`);
