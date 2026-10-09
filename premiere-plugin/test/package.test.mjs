/**
 * Package test: builds the workspace package and validates its contents.
 *
 * It runs the installer inside the workspace only. Nothing is copied into the
 * Adobe CEP folder and no preference is changed.
 *
 * Run: node --test premiere-plugin/test/package.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = join(pluginRoot, 'dist', 'open-silences');

/** Builds once for the whole file. */
function buildPackage() {
  execFileSync('bash', [join(pluginRoot, 'install', 'install.sh')], {
    cwd: pluginRoot,
    stdio: 'pipe'
  });
}

let built = false;
function ensureBuilt() {
  if (!built) {
    buildPackage();
    built = true;
  }
}

test('the installer only writes inside the workspace', () => {
  const script = readFileSync(join(pluginRoot, 'install', 'install.sh'), 'utf8');
  for (const forbidden of ['defaults write', 'Application Support/Adobe', 'sudo ', 'ln -s']) {
    assert.equal(script.includes(forbidden), false, `installer must not contain "${forbidden}"`);
  }
  assert.match(script, /cargo build --release --locked/);
});

test('the package contains every required file', () => {
  ensureBuilt();
  const required = [
    'index.html',
    'CSXS/manifest.xml',
    'js/main.js',
    'js/core.js',
    'js/controller.js',
    'js/workflow.js',
    'js/i18n.js',
    'js/CSInterface.js',
    'js/CSInterface.NOTICE.md',
    'jsx/silences.jsx',
    'jsx/JSON2.NOTICE.md',
    'licenses/GenSDK_IHC-en_US-20120323_1224.pdf',
    'engine/silences-engine'
  ];
  for (const relative of required) {
    const path = join(packageRoot, relative);
    assert.ok(existsSync(path), `missing in package: ${relative}`);
    assert.ok(statSync(path).size > 0, `empty in package: ${relative}`);
  }
  const engine = statSync(join(packageRoot, 'engine', 'silences-engine'));
  assert.ok((engine.mode & 0o111) !== 0, 'the engine must be executable');
});

test('the manifest uses the CEP version syntax and a narrow host range', () => {
  ensureBuilt();
  const manifest = readFileSync(join(packageRoot, 'CSXS', 'manifest.xml'), 'utf8');
  const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
  const bundleVersion = manifest.match(/ExtensionBundleVersion="([^"]+)"/);
  assert.ok(bundleVersion, 'ExtensionBundleVersion missing');
  assert.match(bundleVersion[1], versionPattern, `CEP version must be numeric: ${bundleVersion[1]}`);
  const extensionVersion = manifest.match(/<Extension Id="[^"]+" Version="([^"]+)"/);
  assert.ok(extensionVersion, 'Extension Version missing');
  assert.match(extensionVersion[1], versionPattern, `CEP version must be numeric: ${extensionVersion[1]}`);
  assert.match(manifest, /<ExtensionManifest\s+Version="11\.0"/);
  assert.match(manifest, /<RequiredRuntime Name="CSXS" Version="11\.0" \/>/);
  assert.match(manifest, /<Host Name="PPRO" Version="\[26\.5,26\.6\)" \/>/);
  assert.match(manifest, /Open Silences \(Alpha\)/);
  assert.match(manifest, /\.\/jsx\/silences\.jsx/);
});

test('the package carries only runtime files', () => {
  ensureBuilt();
  const forbidden = [
    'reference',
    'evidence',
    'work',
    'node_modules'
  ];
  // The package is small and known, so a plain file listing is enough.
  const listing = execFileSync('find', [packageRoot, '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(path => path.replace(`${packageRoot}/`, ''));
  for (const relative of listing) {
    for (const needle of forbidden) {
      assert.equal(relative.split('/').includes(needle), false, `forbidden artefact in package: ${relative}`);
    }
    // The panel ships ES modules only.
    assert.equal(relative.endsWith('.cjs'), false, `forbidden artefact in package: ${relative}`);
  }
  assert.ok(listing.length >= 10, `unexpected package size: ${listing.length} files`);
});

test('the packaged modules parse and the engine reports its version', () => {
  ensureBuilt();
  for (const relative of ['js/main.js', 'js/core.js', 'js/controller.js', 'js/workflow.js', 'js/i18n.js']) {
    const path = join(packageRoot, relative);
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
  }
  const version = execFileSync(join(packageRoot, 'engine', 'silences-engine'), ['version'], { encoding: 'utf8' });
  assert.match(version.trim(), /^2\.0\.0$/, `unexpected engine version: ${version}`);
});

test('the licence notice names the official file and denies a general MIT', () => {
  ensureBuilt();
  const notice = readFileSync(join(packageRoot, 'js', 'CSInterface.NOTICE.md'), 'utf8');
  assert.match(notice, /GenSDK_IHC-en_US-20120323_1224\.pdf/);
  assert.match(notice, /raw\.githubusercontent\.com\/Adobe-CEP\/CEP-Resources/);
  assert.match(notice, /keine\*\* allgemeine MIT Lizenz|keine allgemeine MIT Lizenz/);

  // The documented hash must be the hash of the shipped file, so the notice
  // can never drift away from the artefacts.
  const documented = [...notice.matchAll(/sha256 \|? ?`([0-9a-f]{64})`/g)].map(match => match[1]);
  assert.ok(documented.length >= 2, 'the notice must document both Adobe hashes');

  const hashOf = relative =>
    createHash('sha256').update(readFileSync(join(packageRoot, relative))).digest('hex');
  assert.ok(
    documented.includes(hashOf('js/CSInterface.js')),
    'the documented CSInterface hash must match the shipped file'
  );
  assert.ok(
    documented.includes(hashOf('licenses/GenSDK_IHC-en_US-20120323_1224.pdf')),
    'the documented licence hash must match the shipped file'
  );
});


test('the embedded ES3 JSON implementation matches its source notice', () => {
  ensureBuilt();
  const adapter = readFileSync(join(packageRoot, 'jsx/silences.jsx'), 'utf8');
  const bundled = adapter.split('// BEGIN bundled JSON2: ES3 support, Public Domain.\n')[1].split('\n// END bundled JSON2.')[0];
  const notice = readFileSync(join(packageRoot, 'jsx/JSON2.NOTICE.md'), 'utf8');
  assert.ok(notice.includes(createHash('sha256').update(bundled).digest('hex')));
  assert.match(bundled, /Public Domain/);
});
