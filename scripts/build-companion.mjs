import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const result = spawnSync('docker', ['run', '--rm', '--user', '0', '--entrypoint', 'bash', '-v', `${resolve('.')}:/work`, 'opensearchproject/opensearch:3.8.0', '/work/companion/build.sh'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

if (result.status === 0) {
 const file='build/betterreports-opensearch-3.8.0.zip';
 const hash=createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(file+'.sha256',`${hash}  betterreports-opensearch-3.8.0.zip\n`);
 console.log(`Built ${file}; SHA-256 ${hash}`);
}