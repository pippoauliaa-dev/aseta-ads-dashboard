const test = require('node:test');
const assert = require('node:assert/strict');
const { getSupabaseConfig, funnelRecordToEntry, funnelEntryToRecord } = require('../app.js');

test('does not enable remote sync when project config is absent', () => {
  assert.equal(getSupabaseConfig({}), null);
  assert.equal(getSupabaseConfig({ url: 'https://example.supabase.co' }), null);
  assert.equal(getSupabaseConfig({ anonKey: 'public-anon-key' }), null);
});

test('accepts only a Supabase URL and public anon/publishable key', () => {
  assert.deepEqual(getSupabaseConfig({ url: 'https://example.supabase.co', anonKey: 'public-anon-key' }), {
    url: 'https://example.supabase.co', anonKey: 'public-anon-key',
  });
  assert.equal(getSupabaseConfig({ url: 'http://example.supabase.co', anonKey: 'public-anon-key' }), null);
  assert.equal(getSupabaseConfig({ url: 'https://example.supabase.co', anonKey: 'service_role_secret' }), null);
});

test('round-trips local funnel records to database shape without losing deals', () => {
  const record = { user_id: 'user-1', campaign_id: 'camp', campaign_name: 'Campaign', period_since: '2026-10-01', period_until: '2026-10-07', qualified_leads: 4, meetings_scheduled: 2, meetings_attended: 1, deals_closed: 1, outcome_note: 'Won' };
  const entry = funnelRecordToEntry(record);
  assert.equal(entry.dealsClosed, 1);
  assert.deepEqual(funnelEntryToRecord(entry, 'user-1'), record);
});
