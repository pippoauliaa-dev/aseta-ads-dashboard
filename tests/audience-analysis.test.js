const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAudienceAnalysis, getDefaultAnalysisRange, getLastCompleteDate } = require('../app.js');

test('provides a manual analyze control with date range and initially hidden result panel', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = require('node:fs').readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(html, /id="run-audience-analysis"/);
  assert.match(html, /id="audience-analysis-since"/);
  assert.match(html, /id="audience-analysis-until"/);
  assert.match(html, /id="audience-analysis-results" hidden/);
  assert.match(app, /function runAudienceAnalysis\(\)/);
  assert.match(app, /funnelStorageMode !== 'remote'/);
  assert.match(app, /functions\.invoke\('analyze-audience-location'/);
});

test('defaults to the previous completed 28-day period', () => {
  assert.equal(getLastCompleteDate(new Date('2026-10-21T10:00:00Z')), '2026-10-20');
  assert.deepEqual(getDefaultAnalysisRange(new Date('2026-10-21T10:00:00Z')), { since: '2026-09-23', until: '2026-10-20' });
});

test('keeps outcomes separate and funnel quality campaign-scoped', () => {
  const result = summarizeAudienceAnalysis({
    since: '2026-09-21', until: '2026-10-18',
    adSets: [
      { adSetId: 'a1', adSetName: 'Chat A', campaignId: 'c1', campaignName: 'Campaign 1', objective: 'OUTCOME_LEADS', targeting: { locations: { included: [{ name: 'Jawa Barat' }], excluded: [] }, ageMin: 25, ageMax: 55, genders: [1], interests: ['finance'] }, metricsByResultType: { MESSAGING_CONVERSATION: { spend: 100000, results: 10 } } },
      { adSetId: 'a2', adSetName: 'Chat B', campaignId: 'c1', campaignName: 'Campaign 1', objective: 'OUTCOME_LEADS', targeting: { locations: null, ageMin: null, ageMax: null, genders: null, interests: null }, metricsByResultType: { MESSAGING_CONVERSATION: { spend: 120000, results: 12 } } },
      { adSetId: 'a3', adSetName: 'Form C', campaignId: 'c2', campaignName: 'Campaign 2', objective: 'OUTCOME_LEADS', targeting: { locations: { included: [], excluded: [] }, ageMin: null, ageMax: null, genders: null, interests: null }, metricsByResultType: { LEAD: { spend: 80000, results: 4 } } },
    ],
    campaignFunnel: [{ campaignId: 'c1', campaignName: 'Campaign 1', scope: 'campaign', qualifiedLeads: 3, meetingsScheduled: 2, meetingsAttended: 1, dealsClosed: 1 }],
    coverage: { activeAdSets: 3, insightsDays: 28, truncated: false },
    limitations: [],
  });
  assert.equal(result.adSets.length, 3);
  assert.equal(result.adSets[0].metricsByResultType.MESSAGING_CONVERSATION.costPerResult, 10000);
  assert.equal(result.adSets[2].metricsByResultType.LEAD.costPerResult, 20000);
  assert.equal(result.campaignFunnel[0].scope, 'campaign');
  assert.equal('qualifiedLeads' in result.adSets[0], false);
});

test('marks the campaign funnel as unavailable without exact-range rows', () => {
  const result = summarizeAudienceAnalysis({ since: '2026-10-01', until: '2026-10-20', adSets: [], campaignFunnel: [], coverage: {}, limitations: [] });
  assert.ok(result.limitations.some(item => /No exact-date campaign funnel/i.test(item)));
});

test('preserves zero separately from unavailable values and strips unexpected fields', () => {
  const result = summarizeAudienceAnalysis({
    since: '2026-09-21', until: '2026-10-18',
    adSets: [{ adSetId: 'a', targeting: { locations: null }, metricsByResultType: { LEAD: { spend: 50, results: 0 } }, access_token: 'must-not-escape' }],
    campaignFunnel: [], coverage: {}, limitations: [], access_token: 'secret',
  });
  assert.equal(result.adSets[0].metricsByResultType.LEAD.results, 0);
  assert.equal(result.adSets[0].targeting.locations, null);
  assert.equal('access_token' in result, false);
  assert.equal('access_token' in result.adSets[0], false);
});
