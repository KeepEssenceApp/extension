/* The ZIP a release uploads, and the one check it has to pass first (extension#8).

   node dev/release-zip.mjs 1.2.3                 build the ZIP as version 1.2.3 and check it.
                                                  A drill: no tag, no GitHub Release, nothing is published.
   node dev/release-zip.mjs --check <zip> 1.2.3   only check a ZIP

   semantic-release loads this file as a plugin (.releaserc.json). Its `prepare` step runs once the
   next version is known and before the tag and the GitHub Release exist, so when the check throws
   the release stops with nothing published. The browser's extensions page shows manifest.json's
   version, so the ZIP must say the version it is released as. The reader is the system's `unzip`,
   not the build's own ZIP writer: the check sees the file the way a person unpacking it does. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The file the release uploads; .releaserc.json names the same path for @semantic-release/github. */
export const ASSET = 'keepessence-extension.zip';

/** manifest.json's `version` inside the ZIP, read with `unzip -p`. Throws when it cannot be read. */
export function zipVersion(zip) {
  let text;
  try {
    text = execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('`unzip` is not installed, so the ZIP cannot be checked');
    // unzip writes its complaint to stdout or to stderr depending on what is wrong
    throw new Error(`cannot read manifest.json from ${zip}: ${[e.stderr, e.stdout].filter(Boolean).join(' ').trim() || e.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`manifest.json in ${zip} is not JSON`);
  }
  if (typeof manifest?.version !== 'string') throw new Error(`manifest.json in ${zip} has no version`);
  return manifest.version;
}

/** Throws unless the ZIP's manifest.version is exactly `version` (the tag without the v). */
export function checkZipVersion(zip, version) {
  const found = zipVersion(zip);
  if (found !== version) throw new Error(`${zip}: manifest.json says version ${found}, but this release is ${version} (tag v${version})`);
  return found;
}

/** Builds keepessence-extension.zip as `version`, then checks that very file. */
export function packageRelease(version) {
  const built = join(root, `keepessence-extension-${version}.zip`);
  const asset = join(root, ASSET);
  // what is checked must have been made by this run, never left over from an earlier one
  rmSync(built, { force: true });
  rmSync(asset, { force: true });
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, env: { ...process.env, KE_VERSION: version }, stdio: 'inherit' });
  if (!existsSync(built)) throw new Error(`the build did not make ${built}: does build.mjs still take its version from KE_VERSION?`);
  copyFileSync(built, asset);
  return checkZipVersion(asset, version);
}

/** The semantic-release step: runs after the next version is worked out, before anything is published. */
export function prepare(_config, { nextRelease, logger }) {
  logger.log('Packaging the extension as %s', nextRelease.version);
  const found = packageRelease(nextRelease.version);
  logger.log('%s says version %s, the same as the release', ASSET, found);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, zip, version] = process.argv.slice(2);
  try {
    if (first === '--check' && zip && version) console.log(`ok: ${zip} says version ${checkZipVersion(zip, version)}, the same as the release ${version}`);
    else if (first && !first.startsWith('-') && !zip) console.log(`ok: ${ASSET} built as ${packageRelease(first)} and its manifest.json says so`);
    else throw new Error('usage: node dev/release-zip.mjs <x.y.z>   |   node dev/release-zip.mjs --check <zip> <x.y.z>');
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
