const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeOrganicContent } = require('../app.js');

test('shortlists a relevant content item with above-median engagement for an ad test', () => {
  const result = analyzeOrganicContent([
    { caption: 'Kelola aset dan maintenance perusahaan', mediaType: 'VIDEO', organic: { likes: 20, comments: 4, shares: null, saves: null, reach: null, impressions: null } },
    { caption: 'Pengumuman hari libur', mediaType: 'IMAGE', organic: { likes: 2, comments: 0, shares: null, saves: null, reach: null, impressions: null } },
    { caption: 'Asset tracking RFID untuk gudang', mediaType: 'CAROUSEL_ALBUM', organic: { likes: 10, comments: 1, shares: null, saves: null, reach: null, impressions: null } },
  ]);
  assert.equal(result[0].label, 'Kandidat uji iklan');
  assert.match(result[0].reason, /interaksi organik/i);
  assert.match(result[0].reason, /relevan/i);
});

test('does not call engagement strong when data is missing', () => {
  const result = analyzeOrganicContent([
    { caption: 'Asset management', mediaType: 'VIDEO', organic: { likes: null, comments: null, shares: null, saves: null, reach: null, impressions: null } },
  ]);
  assert.equal(result[0].label, 'Belum cukup data');
  assert.match(result[0].reason, /belum tersedia/i);
});
