const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCampaigns } = require('../app.js');

test('aggregates Meta messaging indicators and calculates cost per outcome', () => {
  const totals = aggregateCampaigns([
    { spend: 132200, results: 9, resultType: 'actions:onsite_conversion.messaging_conversation_started_7d' },
    { spend: 95060, results: 5, resultType: 'actions:onsite_conversion.messaging_conversation_started_7d' },
  ]);
  assert.equal(totals.messagingConversations, 14);
  assert.equal(totals.blendedCostPerResult, (132200 + 95060) / 14);
});

test('counts explicit zero-result campaigns without treating missing spent results as zero', () => {
  const withZeroNoSpend = aggregateCampaigns([
    { spend: 10, results: 2, resultType: 'MESSAGING_CONVERSATION' },
    { spend: 0, results: null, resultType: 'MESSAGING_CONVERSATION' },
  ]);
  assert.equal(withZeroNoSpend.messagingConversations, 2);

  const unknownSpentResult = aggregateCampaigns([
    { spend: 10, results: 2, resultType: 'MESSAGING_CONVERSATION' },
    { spend: 5, results: null, resultType: 'MESSAGING_CONVERSATION' },
  ]);
  assert.equal(unknownSpentResult.messagingConversations, null);
  assert.equal(unknownSpentResult.blendedCostPerResult, null);
});
