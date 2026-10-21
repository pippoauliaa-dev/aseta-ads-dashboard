const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeterministicAnalysis, compareWeeklyResults, normalizeFunnel, normalizeFunnelDealRate } = require('../app.js');

const base = {
  period: { since: '2026-10-06', until: '2026-10-12' },
  currency: 'IDR',
  campaigns: [
    { id: 'm1', name: 'Chat A', spend: 100000, results: 10, resultType: 'MESSAGING_CONVERSATION' },
    { id: 'm2', name: 'Chat B', spend: 200000, results: 10, resultType: 'MESSAGING_CONVERSATION' },
    { id: 'l1', name: 'Form A', spend: 80000, results: 4, resultType: 'LEAD' },
  ],
};

test('ranks campaign costs independently within each outcome type', () => {
  const analysis = buildDeterministicAnalysis(base);
  assert.ok(analysis.campaigns.some(item => item.campaignId === 'm1' && item.label === 'strongest'));
  assert.ok(analysis.campaigns.some(item => item.campaignId === 'm2' && item.label === 'needs-attention'));
  assert.equal(analysis.campaigns.some(item => item.campaignId === 'l1'), false);
  assert.ok(analysis.limitations.some(item => /jenis hasil/i.test(item)));
});

test('compares weekly cost only for matching outcome types with complete seven-day data', () => {
  const current = { since: '2026-10-13', until: '2026-10-19', days: 7, campaigns: [
    { id: 'm1', name: 'Chat A', spend: 120000, results: 12, resultType: 'MESSAGING_CONVERSATION' },
  ] };
  const previous = { since: '2026-10-06', until: '2026-10-12', days: 7, campaigns: [
    { id: 'm2', name: 'Chat B', spend: 150000, results: 10, resultType: 'MESSAGING_CONVERSATION' },
  ] };
  assert.equal(compareWeeklyResults(current, previous)[0].currentCost, 10000);
  assert.equal(compareWeeklyResults(current, previous)[0].previousCost, 15000);
  assert.equal(compareWeeklyResults({ ...current, days: 6 }, previous).length, 0);
});

test('adds funnel context only for the exact analyzed date range', () => {
  const analysis = buildDeterministicAnalysis(base, {
    funnelEntries: [
      { campaignId: 'm1', campaignName: 'Chat A', periodSince: '2026-10-06', periodUntil: '2026-10-12', qualifiedLeads: 3, meetingsScheduled: 2, meetingsAttended: 1, dealsClosed: 1 },
      { campaignId: 'm2', campaignName: 'Other period', periodSince: '2026-10-01', periodUntil: '2026-10-05', qualifiedLeads: 99 },
    ],
  });
  assert.ok(analysis.facts.some(item => /3.*qualified/i.test(item)));
  assert.ok(analysis.facts.some(item => /1.*deal/i.test(item)));
  assert.ok(!analysis.facts.some(item => /99.*qualified/i.test(item)));
  assert.ok(analysis.findings.some(item => /deal.*qualified/i.test(item) && /(33\.3|33,3)%/.test(item)));
});

test('rejects negative or fractional deals in funnel backup', () => {
  const { normalizeFunnel } = require('../app.js');
  const base = { schemaVersion: 1, entries: [{ campaignId: 'x', campaignName: 'X', periodSince: '2026-10-06', periodUntil: '2026-10-12', dealsClosed: 1.5 }] };
  assert.throws(() => normalizeFunnel(base), /bilangan bulat/i);
});

test('calculates deal close rate only from a positive qualified B2B denominator', () => {
  assert.equal(normalizeFunnelDealRate({ qualifiedLeads: 3, dealsClosed: 1 }), 1 / 3);
  assert.equal(normalizeFunnelDealRate({ qualifiedLeads: 0, dealsClosed: 0 }), null);
  assert.equal(normalizeFunnelDealRate({ qualifiedLeads: 3, dealsClosed: null }), null);
});
