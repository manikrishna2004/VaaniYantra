/**
 * Builds the zip that buyers download.
 *
 *   node product/package-kit.mjs
 *
 * Writes product/dist/voice-agent-starter-kit-<version>.zip.
 *
 * The allowlist below is deliberate. A denylist is how a .env with live keys
 * ends up in a file you hand to strangers — one new file at the top level and
 * it ships. Anything not named here is not in the zip.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const kit = join(root, 'vaani-starter-kit');
const dist = join(root, 'dist');

const INCLUDE = [
  'README.md',
  'GUIDE.md',
  'LICENCE.txt',
  '.env.example',
  '.gitignore',
  'package.json',
  'server.js',
  'agent',
  'lib',
  'connectors',
  'scripts',
  'setup',
];

// Belt and braces: even inside an included directory, never ship these.
const NEVER = new Set(['.env', 'config.json', 'calls.json', 'greeting.wav', 'node_modules', 'package-lock.json']);

const { version } = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8'));
const name = 'voice-agent-starter-kit-' + version;
const staging = join(dist, name);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const entry of INCLUDE) {
  const from = join(kit, entry);
  if (!existsSync(from)) {
    console.error('missing: ' + entry);
    process.exit(1);
  }
  cpSync(from, join(staging, entry), {
    recursive: true,
    filter: (src) => !NEVER.has(src.split(/[\\/]/).pop()),
  });
}

// Refuse to ship a secret, whatever the lists above say.
const offenders = [];
(function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full);
      continue;
    }
    if (NEVER.has(entry)) offenders.push(full);
    // An API key that made it into a source file or a doc.
    const text = readFileSync(full, 'utf8');
    if (/AIza[0-9A-Za-z_-]{30,}/.test(text)) offenders.push(full + ' (looks like a Google API key)');
    if (/\bEAA[A-Za-z0-9]{40,}/.test(text)) offenders.push(full + ' (looks like a Meta token)');
    if (/\bAC[0-9a-f]{32}\b/.test(text)) offenders.push(full + ' (looks like a Twilio SID)');
  }
})(staging);

if (offenders.length) {
  console.error('\nREFUSING TO PACKAGE — found things that must not ship:');
  offenders.forEach((o) => console.error('  ' + o));
  process.exit(1);
}

const zipPath = join(dist, name + '.zip');
rmSync(zipPath, { force: true });

// PowerShell's Compress-Archive is on every Windows machine; zip is on every
// mac and Linux one. Try each rather than taking a dependency for one call.
try {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      'Compress-Archive -Path "' + staging + '" -DestinationPath "' + zipPath + '" -Force',
    ]);
  } else {
    execFileSync('zip', ['-r', '-q', zipPath, name], { cwd: dist });
  }
} catch (err) {
  console.error('Could not create the zip: ' + err.message);
  process.exit(1);
}

const files = [];
(function count(dir) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) count(f);
    else files.push(f);
  }
})(staging);

console.log('');
console.log('  ' + name + '.zip');
console.log('  ' + files.length + ' files, ' + (statSync(zipPath).size / 1024).toFixed(0) + ' KB');
console.log('  ' + zipPath);
console.log('');
console.log('  Copy it to private/voice-agent-starter-kit.zip locally, or to KIT_FILE_PATH on the VM.');
console.log('');
