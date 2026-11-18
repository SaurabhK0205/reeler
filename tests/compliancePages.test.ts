import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../public');

test('Compliance Pages - verify privacy.html exists and contains essential Meta requirements', () => {
  const filePath = path.join(publicDir, 'privacy.html');
  assert.ok(fs.existsSync(filePath), 'privacy.html must exist');

  const content = fs.readFileSync(filePath, 'utf8');
  assert.ok(content.includes('Privacy Policy'), 'Must have Privacy Policy title');
  assert.ok(content.includes('Instagram Scoped User ID'), 'Must state IGSID collection');
  assert.ok(content.includes('Data Retention and Deletion'), 'Must explain data retention');
  assert.ok(content.includes('saurabhk0205@gmail.com'), 'Must provide contact email');
  assert.ok(content.includes("SAURABH'S"), 'Must state registered enterprise operator name');
  assert.ok(content.includes('Render and Supabase'), 'Must list active infrastructure providers');
  assert.ok(!content.includes('Fly.io'), 'Must not reference retired Fly.io hosting');
});

test('Compliance Pages - verify terms.html exists and contains essential terms', () => {
  const filePath = path.join(publicDir, 'terms.html');
  assert.ok(fs.existsSync(filePath), 'terms.html must exist');

  const content = fs.readFileSync(filePath, 'utf8');
  assert.ok(content.includes('Terms of Service'), 'Must have Terms of Service title');
  assert.ok(content.includes('Acceptable Use'), 'Must specify acceptable use');
  assert.ok(content.includes('Meta Platforms, Inc.'), 'Must state platform relation');
  assert.ok(content.includes("SAURABH'S"), 'Must state registered enterprise operator name');
});

test('Compliance Pages - verify data-deletion.html exists and provides clear instructions', () => {
  const filePath = path.join(publicDir, 'data-deletion.html');
  assert.ok(fs.existsSync(filePath), 'data-deletion.html must exist');

  const content = fs.readFileSync(filePath, 'utf8');
  assert.ok(content.includes('User Data Deletion Instructions'), 'Must have deletion instructions title');
  assert.ok(content.includes('delete my data'), 'Must mention permanent deletion command');
  assert.ok(content.includes('saurabhk0205@gmail.com'), 'Must provide contact email for manual deletion');
  assert.ok(content.includes("SAURABH'S"), 'Must state registered enterprise operator name');
});

test('Compliance Pages - verify index.html links to privacy, terms, and data-deletion', () => {
  const filePath = path.join(publicDir, 'index.html');
  assert.ok(fs.existsSync(filePath), 'index.html must exist');

  const content = fs.readFileSync(filePath, 'utf8');
  assert.ok(content.includes('href="/privacy"'), 'index.html must link to /privacy');
  assert.ok(content.includes('href="/terms"'), 'index.html must link to /terms');
  assert.ok(content.includes('href="/data-deletion"'), 'index.html must link to /data-deletion');
  assert.ok(content.includes("SAURABH'S"), 'index.html footer must display registered enterprise name');
});
