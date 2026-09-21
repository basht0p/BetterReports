import { build } from 'esbuild';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const files = ['server/**/*.ts', 'common/**/*.ts', 'tests/**/*.ts'].flatMap(pattern => globSync(pattern)).map(file => resolve(file).replaceAll('\\', '/'));
await build({ entryPoints: files, outbase: '.', outdir: 'target/test', platform: 'node', target: 'node22', format: 'cjs', bundle: false });
const tests = globSync('target/test/tests/*.test.js');
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
