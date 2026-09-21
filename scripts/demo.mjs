import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['scripts/demo.ts'], outfile: 'target/demo.cjs', platform: 'node', target: 'node22', format: 'cjs', bundle: true, packages: 'external' });
const result = spawnSync(process.execPath, ['target/demo.cjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
