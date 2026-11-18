import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const result = spawnSync('docker', ['run', '--rm', '--user', '0', '--entrypoint', 'bash', '-e', `BETTER_REPORTS_VERSION=${version}`, '-v', `${resolve('.')}:/work`, 'opensearchproject/opensearch:3.10.0', '/work/companion/build.sh'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

if (result.status === 0) {
 const name=`betterreports-opensearch-${version}.zip`, file=`build/${name}`;
 const hash=createHash('sha256').update(await readFile(file)).digest('hex');
 await writeFile(file+'.sha256',`${hash}  ${name}\n`);
 console.log(`Built ${file}; SHA-256 ${hash}`);
}