/**
 * Panel languages: message tables, translator, number format and coverage.
 *
 * Run: node --test premiere-plugin/test/i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGUAGES, MESSAGES, resolveLanguage, createTranslator, createFormat } from '../panel/js/i18n.js';

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every language has the English keys and placeholders', () => {
  assert.deepEqual(LANGUAGES.map(language => language.code), ['en', 'es', 'de']);
  for (const { code } of LANGUAGES) {
    assert.deepEqual(Object.keys(MESSAGES[code]).sort(), Object.keys(MESSAGES.en).sort(), code);
    for (const key of Object.keys(MESSAGES.en)) {
      assert.deepEqual(placeholders(MESSAGES[code][key]), placeholders(MESSAGES.en[key]), `${code} ${key}`);
    }
  }
});

test('no message uses an en dash or em dash', () => {
  for (const { code } of LANGUAGES) {
    for (const [key, text] of Object.entries(MESSAGES[code])) assert.doesNotMatch(text, /[\u2013\u2014]/, `${code} ${key}`);
  }
});

test('locales resolve to a supported language, English by default', () => {
  assert.equal(resolveLanguage('de_DE'), 'de');
  assert.equal(resolveLanguage('es-MX'), 'es');
  assert.equal(resolveLanguage('EN_us'), 'en');
  assert.equal(resolveLanguage('fr_FR'), 'en');
  assert.equal(resolveLanguage(undefined), 'en');
});

test('translator interpolates, pluralises and falls back to English', () => {
  const de = createTranslator('de');
  assert.equal(de.plural('result.cuts', 7, { name: 'B' }), '7 Schnitte. Backup geprüft: B');
  assert.equal(createTranslator('en').plural('result.cuts', 1, { name: 'B' }), '1 cut. Backup verified: B');
  assert.equal(createTranslator('xx').language, 'en');
  assert.equal(de('missing.key'), 'missing.key');
});

test('numbers follow the language', () => {
  const en = createFormat('en'), de = createFormat('de'), es = createFormat('es');
  assert.equal(en.seconds(11.48), '11.5 s');
  assert.equal(de.seconds(11.48), '11,5 s');
  assert.equal(en.percent(22, 115), '19.1%');
  assert.equal(es.percent(22, 115), '19,1 %');
  assert.equal(en.percent(1, 0), '0.0%');
  assert.equal(en.clock(252), '4:12 min');
  assert.equal(de.decimal(-46.9), '-46,9');
});

test('every data-i18n key in the panel exists', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length > 30, `only ${keys.length} keys`);
  for (const key of keys) assert.ok(key in MESSAGES.en, key);
});

test('panel scripts carry no hard coded German copy', () => {
  for (const file of ['main.js', 'workflow.js', 'core.js', 'controller.js']) {
    const source = readFileSync(new URL(`../panel/js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[äöüÄÖÜß]/, file);
  }
});
