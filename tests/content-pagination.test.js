const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('content list paginates filtered rows in pages of five', () => {
  assert.match(app, /CONTENT_PAGE_SIZE\s*=\s*5/);
  assert.match(app, /const pageStart = \(contentPage - 1\) \* CONTENT_PAGE_SIZE/);
  assert.match(app, /filtered\.slice\(pageStart, pageStart \+ CONTENT_PAGE_SIZE\)/);
  assert.match(html, /id="content-pagination"/);
  assert.match(html, /id="content-page-label"/);
  assert.match(html, /id="content-prev-page"/);
  assert.match(html, /id="content-next-page"/);
});

test('changing a content filter returns pagination to the first page', () => {
  assert.match(app, /contentPage\s*=\s*1;[\s\S]{0,100}renderContentAnalysis/);
});
