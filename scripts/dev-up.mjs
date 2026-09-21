import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
await mkdir('.platform/dev-certs', { recursive: true });
try { await access('.platform/dev-secrets.json'); }
catch {
  const password = () => `Br!${randomBytes(24).toString('hex')}Aa9`;
  await writeFile('.platform/dev-secrets.json', JSON.stringify({ admin: password(), owner: password(), other: password(), runner: password() }), { mode: 0o600, flag: 'wx' });
}
const secrets = JSON.parse(await readFile('.platform/dev-secrets.json', 'utf8'));
function docker(args, capture = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: { ...process.env, BR_ADMIN_PASSWORD: secrets.admin, BR_RUNNER_PASSWORD: secrets.runner } });
  if (result.status !== 0) throw new Error(capture ? result.stderr : `Docker command failed (${result.status}).`);
  return result.stdout;
}
try { await access('.platform/dev-certs/server.crt'); }
catch {
  const executable = process.env.OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const result = spawnSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve('.platform/dev-certs/server.key'), '-out', resolve('.platform/dev-certs/server.crt'), '-days', '3', '-subj', '/CN=smtp', '-addext', 'subjectAltName=DNS:smtp'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('OpenSSL is required to create the local SMTP test certificate. Set OPENSSL to its executable path.');
}
docker(['compose', '-f', 'dev/compose.yml', ...(process.argv.includes('--multi') ? ['--profile', 'multi'] : []), 'up', '--build', '-d']);
console.log('Local fixture started: http://localhost:15601/br. Test credentials remain in ignored .platform/dev-secrets.json. Run npm run test:integration to provision and validate it.');
