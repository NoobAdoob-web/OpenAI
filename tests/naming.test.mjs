/**
 * Tests the download file/folder naming. Run with: node tests/naming.test.mjs
 */
import assert from 'node:assert/strict';
import { filesFor, folderFor, baseNameFor, safeName, dateStamp } from '../src/lib/naming.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const post = (extra = {}) => ({
  shortcode: 'Abc123',
  username: 'growthmarketer',
  collection: 'Ad Ideas',
  takenAt: 1700000000, // 2023-11-14 UTC
  media: [{ kind: 'image', url: 'https://cdn.example/p/photo.jpg?token=xyz' }],
  ...extra,
});

test('a single-media post gets one predictable file name', () => {
  const files = filesFor(post());
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'Instagram Library/Ad Ideas/2023-11-14_growthmarketer_Abc123.jpg');
});

test('carousels are numbered in order', () => {
  const files = filesFor(
    post({
      media: [
        { kind: 'image', url: 'https://cdn.example/a.jpg' },
        { kind: 'image', url: 'https://cdn.example/b.webp' },
        { kind: 'video', url: 'https://cdn.example/c.mp4' },
      ],
    })
  );
  assert.deepEqual(
    files.map((f) => f.filename.split('/').pop()),
    ['2023-11-14_growthmarketer_Abc123_1.jpg', '2023-11-14_growthmarketer_Abc123_2.webp', '2023-11-14_growthmarketer_Abc123_3.mp4']
  );
});

test('query strings never leak into the extension', () => {
  const files = filesFor(post({ media: [{ kind: 'video', url: 'https://cdn.example/v/clip.mp4?efg=1&oh=abc' }] }));
  assert.ok(files[0].filename.endsWith('.mp4'), files[0].filename);
});

test('an unknown URL shape still gets a sensible extension', () => {
  assert.ok(filesFor(post({ media: [{ kind: 'video', url: 'https://cdn.example/stream' }] }))[0].filename.endsWith('.mp4'));
  assert.ok(filesFor(post({ media: [{ kind: 'image', url: 'not a url at all' }] }))[0].filename.endsWith('.jpg'));
});

test('characters that would break a file path are stripped', () => {
  // Stripping leaves double spaces behind, which get collapsed to one.
  assert.equal(safeName('Q4 / Q1: "best" ads? <draft>'), 'Q4 Q1 best ads draft');
  assert.equal(safeName('trailing dots...'), 'trailing dots');
  assert.equal(safeName('../../etc/passwd'), 'etcpasswd', 'no path traversal can survive');
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName(null), 'untitled');
});

test('posts with no collection land in an Unsorted folder', () => {
  assert.equal(folderFor(post({ collection: null })), 'Instagram Library/Unsorted');
});

test('a post with no date is labelled rather than dropped', () => {
  assert.equal(dateStamp({ takenAt: null, firstSeen: 0 }).length, 10);
  assert.equal(baseNameFor(post({ username: null })), '2023-11-14_unknown_Abc123');
});

test('very long collection names are truncated, not rejected', () => {
  const folder = folderFor(post({ collection: 'x'.repeat(200) }));
  assert.ok(folder.length < 80, folder);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
