const test = require('node:test');
const assert = require('node:assert/strict');
const { costPerResult, aggregateCampaigns } = require('../app.js');

test('calculates cost per result for messaging conversations and form leads', () => {
  assert.equal(costPerResult({ spend: 132200, results: 9, resultType: 'MESSAGING_CONVERSATION' }), 132200 / 9);
  assert.equal(costPerResult({ spend: 70000, results: 5, resultType: 'LEAD' }), 14000);
});

test('blended cost includes messaging conversations and form leads', () => {
  const totals = aggregateCampaigns([
    { spend: 132200, results: 9, resultType: 'MESSAGING_CONVERSATION' },
    { spend: 95060, results: 5, resultType: 'LEAD' },
  ]);
  assert.equal(totals.blendedCostPerResult, (132200 + 95060) / 14);
});

test('returns unavailable when campaign result count is zero or missing', () => {
  assert.equal(costPerResult({ spend: 100, results: 0, resultType: 'MESSAGING_CONVERSATION' }), null);
  assert.equal(costPerResult({ spend: 100, results: null, resultType: 'LEAD' }), null);
});
