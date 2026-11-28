import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { ASSET, checkZipVersion, zipVersion } from '../../dev/release-zip.mjs';

// extension#8: the v1.2.1 and v1.2.2 ZIPs both said 1.0.0 in manifest.json. The release now builds the ZIP as the
// version it is about to get and checks that file before it is uploaded (dev/release-zip.mjs). The ZIPs here are
// written by this test, not by build.mjs: the check has to read a ZIP whoever wrote it. The real build is rehearsed
// by the "release ZIP drill" step of .github/workflows/ci.yml.
const dir = mkdtempSync(join(tmpdir(), 'ke-release-zip-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A ZIP with the files stored uncompressed: just enough for `unzip -p`. */
function storedZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    parts.push(head, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

let n = 0;
const zipOf = (files: Record<string, string>): string => {
  const path = join(dir, `z${n++}.zip`);
  writeFileSync(path, storedZip(files));
  return path;
};
const withVersion = (version: unknown): string => zipOf({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'KeepEssence', version }), 'options.html': '<p>x</p>' });

test('the check reads manifest.version out of the ZIP', () => {
  assert.equal(zipVersion(withVersion('1.2.3')), '1.2.3');
});

test('a ZIP whose manifest.version is the release version (the tag without the v) passes', () => {
  assert.equal(checkZipVersion(withVersion('1.2.3'), '1.2.3'), '1.2.3');
});

test('a ZIP that says 1.0.0 fails for the next release, and the message names both versions', () => {
  // exactly what v1.2.1 and v1.2.2 were
  assert.throws(() => checkZipVersion(withVersion('1.0.0'), '1.2.3'), /says version 1\.0\.0, but this release is 1\.2\.3 \(tag v1\.2\.3\)/);
});

test('only an exact match passes: not a prefix, not a longer version, not a prerelease', () => {
  for (const found of ['1.2', '1.2.30', '1.2.3.0', '1.2.3-beta.1', ' 1.2.3', '01.2.3']) {
    assert.throws(() => checkZipVersion(withVersion(found), '1.2.3'), /but this release is 1\.2\.3/, found);
  }
});

test('a ZIP that cannot say its version fails instead of passing by default', () => {
  assert.throws(() => checkZipVersion(zipOf({ 'options.html': '<p>x</p>' }), '1.2.3'), /cannot read manifest\.json/);
  assert.throws(() => checkZipVersion(zipOf({ 'manifest.json': '{ not json' }), '1.2.3'), /is not JSON/);
  assert.throws(() => checkZipVersion(zipOf({ 'manifest.json': '{"name":"KeepEssence"}' }), '1.2.3'), /has no version/);
  assert.throws(() => checkZipVersion(withVersion(3), '3'), /has no version/); // a number is not a version string
  const notAZip = join(dir, 'not-a-zip.zip');
  writeFileSync(notAZip, 'this is text');
  assert.throws(() => checkZipVersion(notAZip, '1.2.3'), /cannot read manifest\.json/);
  assert.throws(() => checkZipVersion(join(dir, 'missing.zip'), '1.2.3'), /cannot read manifest\.json/);
});

/* The command line is how a person re-checks a ZIP (node dev/release-zip.mjs --check <zip> <version>). It must
   answer the same whether the script is reached by its real path or through a symlink (on a Mac /tmp is one):
   by the old test of "am I the script that was started" it silently did nothing there and exited 0. */
test('the command refuses a wrong ZIP, accepts a right one and prints its usage, by the real path and through a symlink', () => {
  const real = fileURLToPath(new URL('../../dev', import.meta.url));
  const link = join(dir, 'dev-link');
  symlinkSync(real, link);
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  for (const script of [join(real, 'release-zip.mjs'), join(link, 'release-zip.mjs')]) {
    const wrong = run(script, ['--check', withVersion('1.0.0'), '9.9.9']);
    assert.equal(wrong.status, 1, `${script}: a ZIP that says 1.0.0 is refused for 9.9.9`);
    assert.match(wrong.stderr, /^FAIL: .*says version 1\.0\.0, but this release is 9\.9\.9 \(tag v9\.9\.9\)/);
    const right = run(script, ['--check', withVersion('9.9.9'), '9.9.9']);
    assert.equal(right.status, 0, `${script}: a ZIP that says 9.9.9 passes for 9.9.9`);
    assert.match(right.stdout, /^ok: .* says version 9\.9\.9, the same as the release 9\.9\.9/);
    const nothing = run(script, []);
    assert.equal(nothing.status, 1, `${script}: no arguments is a usage error, not a pass`);
    assert.match(nothing.stderr, /usage: node dev\/release-zip\.mjs/);
  }
});

test('.releaserc.json runs the check before anything is published, on the file it uploads', () => {
  const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8'));
  const names: string[] = rc.plugins.map((p: string | [string, unknown]) => (typeof p === 'string' ? p : p[0]));
  assert.ok(names.includes('./dev/release-zip.mjs'), 'the check is a plugin of the release');
  const github = rc.plugins.find((p: unknown) => Array.isArray(p) && p[0] === '@semantic-release/github');
  assert.deepEqual(
    github[1].assets.map((a: { path: string }) => a.path),
    [ASSET],
    'the Release uploads the file the check reads, and only that file',
  );
});
