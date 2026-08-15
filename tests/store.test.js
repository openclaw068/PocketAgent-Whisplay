// Durability tests for store.js — the atomic-write / corruption-recovery path.
// Run with: npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJson, saveJson } from '../pocketagent/store.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-store-'));
  return path.join(dir, 'reminders.json');
}

test('round-trips data', () => {
  const p = tmpFile();
  saveJson(p, { reminders: [{ id: '1', text: 'trash' }] });
  assert.deepEqual(loadJson(p, null), { reminders: [{ id: '1', text: 'trash' }] });
});

test('missing file returns fallback without quarantining', () => {
  const p = tmpFile();
  assert.deepEqual(loadJson(p, { reminders: [] }), { reminders: [] });
  assert.equal(fs.readdirSync(path.dirname(p)).length, 0);
});

test('leaves no temp files behind', () => {
  const p = tmpFile();
  saveJson(p, { a: 1 });
  const stray = fs.readdirSync(path.dirname(p)).filter(f => f.includes('.tmp-'));
  assert.deepEqual(stray, []);
});

test('recovers reminders from backup after a truncated write', () => {
  const p = tmpFile();
  saveJson(p, { reminders: [{ id: '1', text: 'take out trash' }] });
  saveJson(p, { reminders: [{ id: '1', text: 'take out trash' }, { id: '2', text: 'pay rent' }] });

  // Simulate a hard power cut mid-write.
  fs.writeFileSync(p, '{ "reminders": [ { "id": "1", "te');

  const got = loadJson(p, { reminders: [] });
  assert.ok(got.reminders.length > 0, 'must NOT silently return the empty fallback');
  assert.equal(got.reminders[0].text, 'take out trash');
});

test('quarantines a corrupt file when no backup exists', () => {
  const p = tmpFile();
  fs.writeFileSync(p, 'not json at all');
  const got = loadJson(p, { reminders: [] });
  assert.deepEqual(got, { reminders: [] });
  const quarantined = fs.readdirSync(path.dirname(p)).filter(f => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, 'corrupt data must be preserved, not discarded');
});

test('repairs the primary file after recovering from backup', () => {
  const p = tmpFile();
  saveJson(p, { v: 1 });
  saveJson(p, { v: 2 });
  fs.writeFileSync(p, '{{{');
  loadJson(p, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { v: 1 });
});
