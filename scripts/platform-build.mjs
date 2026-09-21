import { spawnSync } from 'node:child_process';
// The archive builder targets the exact loader contracts checked here. It avoids
// requiring a full Dashboards monorepo bootstrap merely to distribute this plugin.
for (const script of ['scripts/check-platform.mjs', 'scripts/build.mjs']) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
