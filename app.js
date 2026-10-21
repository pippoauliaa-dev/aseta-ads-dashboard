(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AsetaDashboard = api;
  if (root && root.document && root.document.getElementById('status-message')) api.init(root.document);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FUNNEL_KEY = 'asetaAdsDashboard:funnel:v1';
  const SNAPSHOT_VERSION = 1;
  const CONTENT_PAGE_SIZE = 5;
  const FUNNEL_VERSION = 1;
  const SUPABASE_CONFIG_KEY = 'asetaAdsDashboard:supabase-config:v1';
  const SUPABASE_SESSION_KEY = 'asetaAdsDashboard:supabase-session:v1';
  const SUPABASE_TABLE = 'private_funnel_records';
  const FUNNEL_FIELDS = ['qualifiedLeads', 'meetingsScheduled', 'meetingsAttended', 'dealsClosed'];
  const MISSING = new Set(['', '—', '-', '–', 'na', 'n/a', 'null']);

  function parseLocalizedNumber(value) {
    if (value === null || value === undefined || typeof value === 'number') {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    let text = String(value).trim();
    if (MISSING.has(text.toLowerCase())) return null;
    const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
    text = text.replace(/[()\s ]/g, '').replace(/rp/ig, '').replace(/[^\d.,]/g, '');
    if (!text || !/\d/.test(text)) return null;
    if (text.includes(',') && text.includes('.')) {
      const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
      text = decimal === ','
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
    } else if (text.includes(',')) {
      const parts = text.split(',');
      text = parts.length === 2 && parts[1].length !== 3
        ? `${parts[0].replace(/\./g, '')}.${parts[1]}`
        : parts.join('');
    } else if (text.includes('.')) {
      const parts = text.split('.');
      text = parts.length === 2 && parts[1].length !== 3
        ? text
        : parts.join('');
    }
    const number = Number(text);
    return Number.isFinite(number) ? (negative ? -number : number) : null;
  }

  function safeRate(numerator, denominator) {
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? numerator / denominator
      : null;
  }

  function getSupabaseConfig(input) {
    if (!input || typeof input !== 'object') return null;
    const url = typeof input.url === 'string' ? input.url.trim().replace(/\/$/, '') : '';
    const anonKey = typeof input.anonKey === 'string' ? input.anonKey.trim() : '';
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) return null;
    if (!anonKey || /service[_-]?role/i.test(anonKey)) return null;
    return { url, anonKey };
  }

  function funnelRecordToEntry(record) {
    return {
      campaignId: record.campaign_id,
      campaignName: record.campaign_name,
      periodSince: record.period_since,
      periodUntil: record.period_until,
      qualifiedLeads: record.qualified_leads,
      meetingsScheduled: record.meetings_scheduled,
      meetingsAttended: record.meetings_attended,
      dealsClosed: record.deals_closed,
      outcomeNote: record.outcome_note ?? '',
    };
  }

  function funnelEntryToRecord(entry, userId) {
    return {
      user_id: userId,
      campaign_id: entry.campaignId,
      campaign_name: entry.campaignName,
      period_since: entry.periodSince,
      period_until: entry.periodUntil,
      qualified_leads: entry.qualifiedLeads,
      meetings_scheduled: entry.meetingsScheduled,
      meetings_attended: entry.meetingsAttended,
      deals_closed: entry.dealsClosed,
      outcome_note: entry.outcomeNote,
    };
  }

  function normalizeFunnelDealRate(entry) {
    if (entry?.qualifiedLeads === null || entry?.qualifiedLeads === undefined || entry.qualifiedLeads <= 0
      || !Number.isFinite(entry.dealsClosed)) return null;
    return entry.dealsClosed / entry.qualifiedLeads;
  }

  function costPerResult(campaign) {
    return Number.isFinite(campaign.spend) && Number.isFinite(campaign.results) && campaign.results > 0
      ? campaign.spend / campaign.results
      : null;
  }

  function compareWeeklyResults(current, previous) {
    if (!current?.complete || !previous?.complete) return [];
    const aggregateByType = week => {
      const result = new Map();
      for (const campaign of week.campaigns ?? []) {
        const type = campaign.resultType;
        if (!['MESSAGING_CONVERSATION', 'LEAD'].includes(type)) continue;
        if (!Number.isFinite(campaign.spend) || !Number.isFinite(campaign.results)) return null;
        const group = result.get(type) ?? { spend: 0, results: 0 };
        group.spend += campaign.spend;
        group.results += campaign.results;
        result.set(type, group);
      }
      return result;
    };
    const currentGroups = aggregateByType(current);
    const previousGroups = aggregateByType(previous);
    if (!currentGroups || !previousGroups) return [];
    return [...currentGroups.entries()].flatMap(([type, values]) => {
      const previousValues = previousGroups.get(type);
      if (!previousValues || values.results <= 0 || previousValues.results <= 0) return [];
      const currentCost = values.spend / values.results;
      const previousCost = previousValues.spend / previousValues.results;
      return [{ resultType: type, currentCost, previousCost, deltaPercent: (currentCost / previousCost - 1) * 100 }];
    });
  }

  function normalizeResultType(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const type = value.trim().toUpperCase();
    if (type.includes('MESSAGING_CONVERSATION_STARTED')) return 'MESSAGING_CONVERSATION';
    if (type === 'ACTIONS:LEADGEN.OTHER' || type.includes('LEADGEN')) return 'LEAD';
    if (type.includes('LANDING_PAGE_VIEW')) return 'LANDING_PAGE_VIEW';
    if (type === 'ACTIONS:LINK_CLICK' || type === 'LINK_CLICK') return 'LINK_CLICK';
    if (type === 'REACH') return 'REACH';
    return type;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function isDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  }

  function validTimestamp(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }

  function optionalMetric(value, label) {
    if (value === null || value === undefined || value === '') return null;
    const number = typeof value === 'number' ? value : parseLocalizedNumber(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} harus berupa angka nonnegatif atau kosong.`);
    return number;
  }

  function normalizeAnalysis(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const generatedAt = validTimestamp(input.generatedAt) ? input.generatedAt : null;
    const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'assistant-analysis';
    const text = value => typeof value === 'string' ? value.trim().slice(0, 1000) : null;
    const list = value => Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 20) : [];
    const labels = new Set(['strongest', 'needs-attention', 'not-comparable']);
    const campaigns = Array.isArray(input.campaigns) ? input.campaigns.map(item => {
      if (!item || typeof item !== 'object' || !String(item.campaignId ?? '').trim() || !labels.has(item.label)) return null;
      const reason = text(item.reason);
      return reason ? { campaignId: String(item.campaignId), label: item.label, reason } : null;
    }).filter(Boolean).slice(0, 100) : [];
    if (!generatedAt && !text(input.summary) && !list(input.facts).length && !list(input.findings).length
      && !list(input.recommendations).length && !list(input.limitations).length && !campaigns.length) return null;
    return {
      generatedAt,
      source,
      summary: text(input.summary),
      facts: list(input.facts),
      findings: list(input.findings),
      recommendations: list(input.recommendations),
      limitations: list(input.limitations),
      campaigns,
    };
  }

  function compareWeeklyResults(current, previous) {
    if (current.days !== 7 || previous.days !== 7) return [];
    const byType = period => {
      const groups = new Map();
      for (const campaign of period.campaigns ?? []) {
        if (!['MESSAGING_CONVERSATION', 'LEAD'].includes(campaign.resultType)) continue;
        if (!Number.isFinite(campaign.spend) || !Number.isFinite(campaign.results)) return null;
        const group = groups.get(campaign.resultType) ?? { spend: 0, results: 0 };
        group.spend += campaign.spend;
        group.results += campaign.results;
        groups.set(campaign.resultType, group);
      }
      return groups;
    };
    const currentGroups = byType(current);
    const previousGroups = byType(previous);
    if (!currentGroups || !previousGroups) return [];
    return [...currentGroups.entries()].flatMap(([type, values]) => {
      const old = previousGroups.get(type);
      if (!old || values.results <= 0 || old.results <= 0) return [];
      return [{
        resultType: type,
        currentCost: values.spend / values.results,
        previousCost: old.spend / old.results,
        deltaPercent: ((values.spend / values.results) / (old.spend / old.results) - 1) * 100,
        currentResults: values.results,
        previousResults: old.results,
      }];
    });
  }

  function buildDeterministicAnalysis(snapshot, options = {}) {
    const campaigns = Array.isArray(snapshot?.campaigns) ? snapshot.campaigns : [];
    const resultTypes = [...new Set(campaigns.map(item => item.resultType).filter(Boolean))];
    const totals = aggregateCampaigns(campaigns);
    const limitations = [];
    const facts = [`Periode analisis: ${snapshot?.period?.since ?? 'tidak diketahui'} sampai ${snapshot?.period?.until ?? 'tidak diketahui'}.`, `${campaigns.length} baris campaign dianalisis.`];
    if (!campaigns.length) limitations.push('Belum ada campaign untuk dianalisis.');
    if (campaigns.some(item => item.spend === null || item.results === null)) limitations.push('Sebagian metrik belanja atau hasil tidak tersedia; biaya per hasil campaign tersebut tidak dihitung.');
    if (resultTypes.length > 1) limitations.push('Jenis hasil berbeda. Campaign chat dan formulir hanya dibandingkan di dalam jenis hasil masing-masing.');
    if (campaigns.some(item => item.results !== null && !item.resultType)) limitations.push('Ada hasil tanpa jenis hasil yang jelas; hasil tersebut tidak dimasukkan ke perbandingan.');
    if (resultTypes.length > 1) limitations.push('Biaya gabungan chat + formulir bersifat indikatif; biaya per jenis hasil lebih tepat untuk optimasi.');
    const rankedByType = campaigns.filter(item => Number.isFinite(item.spend) && Number.isFinite(item.results) && item.results > 0 && ['MESSAGING_CONVERSATION', 'LEAD'].includes(item.resultType))
      .map(item => ({ item, cost: item.spend / item.results }))
      .reduce((groups, entry) => { (groups[entry.item.resultType] ??= []).push(entry); return groups; }, {});
    const trendComparisons = options.weeklyComparisons ?? [];
    const campaignAnalysis = Object.entries(rankedByType).flatMap(([type, entries]) => {
      entries.sort((a, b) => a.cost - b.cost);
      return entries.length > 1 ? entries.map((entry, index) => ({
        campaignId: entry.item.id,
        label: index === 0 ? 'strongest' : index === entries.length - 1 ? 'needs-attention' : 'not-comparable',
        reason: `Biaya ${formatMoney(entry.cost)} per ${type === 'LEAD' ? 'prospek formulir' : 'percakapan pesan'}; dibandingkan hanya dengan campaign berjenis hasil sama.`,
      })) : [];
    });
    const actions = [];
    if (campaignAnalysis.length) actions.push('Gunakan perbandingan biaya hanya di dalam jenis hasil yang sama; validasi kualitas percakapan dan prospek di CRM sebelum memindahkan anggaran.');
    if (campaigns.some(item => item.status === 'ACTIVE' && item.spend > 0 && item.results === 0)) actions.push('Tinjau campaign aktif yang sudah berbelanja tetapi belum mencatat hasil pada periode ini.');
    if (campaigns.some(item => item.status === 'ACTIVE' && item.spend > 0 && item.results === null)) actions.push('Periksa pelaporan hasil pada campaign aktif yang memiliki belanja tetapi hasilnya tidak tersedia.');
    const findings = [];
    if (totals.messagingConversations > 0) facts.push(`${formatNumber(totals.messagingConversations)} percakapan pesan tercatat.`);
    if (totals.formLeads > 0) facts.push(`${formatNumber(totals.formLeads)} prospek formulir tercatat.`);
    if (totals.blendedCostPerResult !== null) facts.push(`Biaya gabungan kampanye berorientasi hasil sekitar ${formatMoney(totals.blendedCostPerResult)} per percakapan atau prospek; ini bukan perbandingan antarjenis hasil.`);
    if (resultTypes.includes('REACH')) findings.push('Hasil Reach dari campaign awareness dipisahkan dari percakapan dan prospek.');
    for (const [type, entries] of Object.entries(rankedByType)) {
      if (entries.length < 2) continue;
      const ordered = [...entries].sort((a, b) => a.cost - b.cost);
      findings.push(`${ordered[0].item.name} memiliki biaya terendah untuk ${type === 'LEAD' ? 'prospek formulir' : 'percakapan pesan'} (${formatMoney(ordered[0].cost)}); ${ordered[ordered.length - 1].item.name} tertinggi (${formatMoney(ordered[ordered.length - 1].cost)}). Ini perbandingan observasional, bukan bukti sebab-akibat.`);
    }
    if (options.funnelEntries) {
      const matching = options.funnelEntries.filter(entry => entry.periodSince === snapshot.period?.since && entry.periodUntil === snapshot.period?.until);
      if (matching.length) {
        const qualified = matching.reduce((sum, entry) => sum + (entry.qualifiedLeads ?? 0), 0);
        const scheduled = matching.reduce((sum, entry) => sum + (entry.meetingsScheduled ?? 0), 0);
        const attended = matching.reduce((sum, entry) => sum + (entry.meetingsAttended ?? 0), 0);
        const deals = matching.reduce((sum, entry) => sum + (entry.dealsClosed ?? 0), 0);
        const hasQualified = matching.some(entry => entry.qualifiedLeads !== null);
        const hasScheduled = matching.some(entry => entry.meetingsScheduled !== null);
        const hasAttended = matching.some(entry => entry.meetingsAttended !== null);
        const hasDeals = matching.some(entry => entry.dealsClosed !== null);
        facts.push(`Funnel manual untuk rentang yang sama: ${hasQualified ? `${qualified} qualified B2B` : 'qualified B2B tidak dicatat'}, ${hasScheduled ? `${scheduled} meeting dijadwalkan` : 'jadwal meeting tidak dicatat'}, ${hasAttended ? `${attended} meeting dihadiri` : 'kehadiran meeting tidak dicatat'}, ${hasDeals ? `${deals} deal` : 'deal tidak dicatat'}.`);
        const qualificationRate = safeRate(qualified, totals.messagingConversations);
        if (hasQualified && totals.messagingConversations > 0 && qualificationRate !== null) findings.push(`${formatNumber(qualified)} qualified B2B dari ${formatNumber(totals.messagingConversations)} percakapan pesan (${formatNumber(qualificationRate * 100, 1)}%). Rasio indikatif; funnel manual dapat mencakup kanal lain.`);
        const dealRate = safeRate(deals, qualified);
        if (hasDeals && hasQualified && dealRate !== null) findings.push(`${formatNumber(deals)} deal dari ${formatNumber(qualified)} qualified B2B (${formatNumber(dealRate * 100, 1)}%); hubungan ini indikatif untuk periode dan campaign yang dicatat.`);
      } else {
        limitations.push('Belum ada catatan funnel manual dengan tanggal yang persis sama dengan periode analisis.');
      }
    }
    const weeklyComparisons = options.weeklyComparisons ?? [];
    for (const comparison of weeklyComparisons) {
      const name = comparison.resultType === 'LEAD' ? 'prospek formulir' : 'percakapan pesan';
      const direction = comparison.deltaPercent < 0 ? 'turun' : 'naik';
      findings.push(`Biaya per ${name} ${direction} ${formatNumber(Math.abs(comparison.deltaPercent), 1)}% dibanding minggu sebelumnya (${formatMoney(comparison.previousCost)} → ${formatMoney(comparison.currentCost)}). Perubahan biaya bersifat observasional.`);
    }
    if (options.previousWeek && !weeklyComparisons.length) limitations.push('Tren mingguan tidak ditampilkan karena data pembanding, rentang tujuh hari penuh, atau jenis hasil yang cocok tidak tersedia.');
    return normalizeAnalysis({
      generatedAt: new Date().toISOString(), source: 'assistant-analysis',
      summary: campaigns.length
        ? `Analisis indikatif untuk ${campaigns.length} campaign. Percakapan: ${formatNumber(totals.messagingConversations)}; prospek formulir: ${formatNumber(totals.formLeads)}. Campaign dibandingkan hanya dalam jenis hasil yang sama.`
        : 'Belum ada data campaign untuk dianalisis.',
      facts, findings, recommendations: actions, limitations, campaigns: campaignAnalysis,
    });
  }

  function normalizeSnapshot(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== SNAPSHOT_VERSION) {
      throw new Error('Format snapshot tidak valid atau versinya belum didukung.');
    }
    if (!input.period || !isDate(input.period.since) || !isDate(input.period.until) || input.period.since > input.period.until) {
      throw new Error('Rentang tanggal snapshot tidak valid.');
    }
    if (!validTimestamp(input.fetchedAt)) throw new Error('Waktu pembaruan snapshot tidak valid.');
    if (!Array.isArray(input.campaigns)) throw new Error('Daftar campaign snapshot tidak valid.');
    if (input.currency !== 'IDR') throw new Error('MVP ini hanya menerima mata uang IDR.');
    const source = ['meta-read', 'csv-import', 'demo'].includes(input.source) ? input.source : null;
    if (!source) throw new Error('Sumber snapshot tidak dikenal.');
    const accountTotals = input.accountTotals && typeof input.accountTotals === 'object'
      ? {
        spend: optionalMetric(input.accountTotals.spend, 'Spend akun'),
        reach: optionalMetric(input.accountTotals.reach, 'Reach akun'),
        impressions: optionalMetric(input.accountTotals.impressions, 'Impresi akun'),
        linkClicks: optionalMetric(input.accountTotals.linkClicks, 'Klik tautan akun'),
        results: optionalMetric(input.accountTotals.results, 'Hasil akun'),
        resultType: typeof input.accountTotals.resultType === 'string' ? input.accountTotals.resultType : null,
      }
      : null;
    const campaigns = input.campaigns.map((campaign, index) => {
      if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)) {
        throw new Error(`Data campaign baris ${index + 1} tidak valid.`);
      }
      const resultType = normalizeResultType(campaign.resultType);
      return {
        id: String(campaign.id ?? `row-${index + 1}`),
        name: String(campaign.name ?? `Campaign ${index + 1}`),
        status: String(campaign.status ?? 'UNKNOWN'),
        spend: optionalMetric(campaign.spend, 'Spend'),
        reach: optionalMetric(campaign.reach, 'Reach'),
        impressions: optionalMetric(campaign.impressions, 'Impresi'),
        linkClicks: optionalMetric(campaign.linkClicks, 'Klik tautan'),
        results: optionalMetric(campaign.results, 'Hasil'),
        resultType,
        dailyBudget: optionalMetric(campaign.dailyBudget, 'Anggaran harian'),
        lifetimeBudget: optionalMetric(campaign.lifetimeBudget, 'Anggaran total'),
        stopTime: validTimestamp(campaign.stopTime) ? campaign.stopTime : null,
      };
    });
    return {
      schemaVersion: SNAPSHOT_VERSION,
      accountName: String(input.accountName ?? 'Akun Meta Ads'),
      currency: 'IDR',
      period: { since: input.period.since, until: input.period.until },
      fetchedAt: input.fetchedAt,
      source,
      analysis: normalizeAnalysis(input.analysis),
      aiAnalysis: normalizeAnalysis(input.aiAnalysis),
      aiAnalysisByWeek: input.aiAnalysisByWeek && typeof input.aiAnalysisByWeek === 'object' && !Array.isArray(input.aiAnalysisByWeek)
        ? Object.fromEntries(Object.entries(input.aiAnalysisByWeek).filter(([week, value]) => isDate(week) && normalizeAnalysis(value)).map(([week, value]) => [week, normalizeAnalysis(value)]))
        : {},
      contents: Array.isArray(input.contents) ? input.contents.filter(item => item && typeof item === 'object' && String(item.contentId ?? '').trim()).map(item => ({
        platform: String(item.platform ?? 'unknown'), contentId: String(item.contentId), publishedAt: item.publishedAt ?? null,
        mediaType: String(item.mediaType ?? 'UNKNOWN'), permalink: typeof item.permalink === 'string' ? item.permalink : null,
        caption: String(item.caption ?? ''), organic: item.organic && typeof item.organic === 'object' ? {
          likes: optionalMetric(item.organic.likes, 'Likes'), comments: optionalMetric(item.organic.comments, 'Komentar'),
          reach: optionalMetric(item.organic.reach, 'Reach konten'), impressions: optionalMetric(item.organic.impressions, 'Impresi konten'),
          shares: optionalMetric(item.organic.shares, 'Shares'), saves: optionalMetric(item.organic.saves, 'Saves'), videoViews: optionalMetric(item.organic.videoViews, 'Video views'),
        } : { likes: null, comments: null, reach: null, impressions: null, shares: null, saves: null, videoViews: null },
        status: ['PROMOTE', 'TEST', 'KEEP_ORGANIC', 'DEPRIORITIZE'].includes(item.classification?.status) ? item.classification.status : 'TEST',
      })) : [],
      entityLevel: ['campaign', 'adset', 'ad'].includes(input.entityLevel) ? input.entityLevel : 'campaign',
      accountTotals,
      opportunityScore: Number.isFinite(input.opportunityScore) ? input.opportunityScore : null,
      recommendations: Array.isArray(input.recommendations) ? input.recommendations.filter(item => item && typeof item.title === 'string' && typeof item.claim === 'string' && typeof item.url === 'string' && /^https:\/\/adsmanager\.facebook\.com\//.test(item.url)).map(item => ({ title: String(item.title), claim: String(item.claim), url: item.url })) : [],
      dailyMetrics: Array.isArray(input.dailyMetrics) ? input.dailyMetrics.filter(day => isDate(day.date) && Array.isArray(day.campaigns)).map(day => ({
        date: day.date,
        campaigns: day.campaigns.filter(item => item && typeof item === 'object' && typeof item.id === 'string').map(item => ({
          id: item.id,
          name: String(item.name ?? item.id),
          status: String(item.status ?? 'UNKNOWN'),
          resultType: normalizeResultType(item.resultType),
          spend: optionalMetric(item.spend, 'Spend harian'),
          reach: optionalMetric(item.reach, 'Reach harian'),
          impressions: optionalMetric(item.impressions, 'Impresi harian'),
          linkClicks: optionalMetric(item.linkClicks, 'Klik tautan harian'),
          results: optionalMetric(item.results, 'Hasil harian'),
        })),
      })) : [],
      campaigns,
    };
  }

  function sumKnown(campaigns, field) {
    if (!campaigns.length || campaigns.some(item => !Number.isFinite(item[field]))) return null;
    return campaigns.reduce((total, item) => total + item[field], 0);
  }

  function aggregateCampaigns(campaigns) {
    const resultTypes = [...new Set(campaigns.map(item => normalizeResultType(item.resultType)).filter(Boolean))];
    const sameResultType = resultTypes.length === 1
      && campaigns.every(item => item.results !== null && normalizeResultType(item.resultType) === resultTypes[0]);
    const sumResultType = type => {
      const matching = campaigns.filter(item => normalizeResultType(item.resultType) === type);
      if (!matching.length) return 0;
      if (matching.some(item => item.results === null && Number.isFinite(item.spend) && item.spend > 0)) return null;
      return matching.reduce((total, item) => total + (Number.isFinite(item.results) ? item.results : 0), 0);
    };
    const messagingConversations = sumResultType('MESSAGING_CONVERSATION');
    const formLeads = sumResultType('LEAD');
    const outcomeCampaigns = campaigns.filter(item => item.resultType === 'MESSAGING_CONVERSATION' || item.resultType === 'LEAD');
    const blendedResults = outcomeCampaigns.length && outcomeCampaigns.every(item => Number.isFinite(item.results)
      || (item.results === null && item.spend === 0))
      ? outcomeCampaigns.reduce((total, item) => total + (Number.isFinite(item.results) ? item.results : 0), 0)
      : null;
    const spend = sumKnown(campaigns, 'spend');
    return {
      spend,
      reach: sumKnown(campaigns, 'reach'),
      reachIsUnique: false,
      impressions: sumKnown(campaigns, 'impressions'),
      linkClicks: sumKnown(campaigns, 'linkClicks'),
      results: sameResultType ? sumKnown(campaigns, 'results') : null,
      resultType: sameResultType ? resultTypes[0] : null,
      messagingConversations,
      formLeads,
      blendedCostPerResult: blendedResults !== null && blendedResults > 0 && spend !== null ? spend / blendedResults : null,
    };
  }

  function normalizeFunnel(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== FUNNEL_VERSION || !Array.isArray(input.entries)) {
      throw new Error('Backup funnel tidak valid atau versinya belum didukung.');
    }
    const seen = new Set();
    const entries = input.entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !String(entry.campaignId ?? '').trim()
        || !isDate(entry.periodSince) || !isDate(entry.periodUntil) || entry.periodSince > entry.periodUntil) {
        throw new Error(`Data funnel baris ${index + 1} atau tanggalnya tidak valid.`);
      }
      const normalized = {
        campaignId: String(entry.campaignId),
        campaignName: String(entry.campaignName ?? entry.campaignId),
        periodSince: entry.periodSince,
        periodUntil: entry.periodUntil,
        qualifiedLeads: null,
        meetingsScheduled: null,
        meetingsAttended: null,
        dealsClosed: null,
        outcomeNote: String(entry.outcomeNote ?? '').slice(0, 500),
      };
      for (const field of FUNNEL_FIELDS) {
        const value = entry[field];
        if (value === null || value === undefined || value === '') continue;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Angka ${field} harus bilangan bulat nonnegatif atau kosong.`);
        normalized[field] = value;
      }
      if (normalized.meetingsAttended !== null && normalized.meetingsScheduled !== null
        && normalized.meetingsAttended > normalized.meetingsScheduled) {
        throw new Error('Meeting dihadiri tidak boleh melebihi jumlah meeting yang dijadwalkan.');
      }
      if (normalized.dealsClosed !== null && normalized.qualifiedLeads !== null
        && normalized.dealsClosed > normalized.qualifiedLeads) {
        throw new Error('Deal tidak boleh melebihi jumlah qualified B2B.');
      }
      const key = funnelIdentity(normalized);
      if (seen.has(key)) throw new Error('Backup memiliki data campaign dan periode ganda.');
      seen.add(key);
      return normalized;
    });
    return { schemaVersion: FUNNEL_VERSION, entries };
  }

  function funnelIdentity(entry) {
    return JSON.stringify([entry.campaignId, entry.periodSince, entry.periodUntil]);
  }

  function mergeManualFunnel(existing, incoming) {
    const base = normalizeFunnel(existing);
    const additions = normalizeFunnel({ schemaVersion: FUNNEL_VERSION, entries: incoming }).entries;
    const entries = new Map(base.entries.map(entry => [funnelIdentity(entry), entry]));
    for (const entry of additions) entries.set(funnelIdentity(entry), entry);
    return { schemaVersion: FUNNEL_VERSION, entries: [...entries.values()] };
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const input = String(text).replace(/^﻿/, '');
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (quoted) {
        if (character === '"' && input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"' && field === '') {
        quoted = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n' || character === '\r') {
        row.push(field);
        if (row.some(value => value.trim() !== '')) rows.push(row);
        row = [];
        field = '';
        if (character === '\r' && input[index + 1] === '\n') index += 1;
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error('CSV tidak valid: ada tanda kutip yang belum ditutup.');
    if (field !== '' || row.length) {
      row.push(field);
      if (row.some(value => value.trim() !== '')) rows.push(row);
    }
    if (!rows.length) throw new Error('File CSV kosong.');
    const width = rows[0].length;
    if (rows.some(item => item.length !== width)) throw new Error('CSV tidak konsisten: jumlah kolom berbeda antarbaris.');
    return rows;
  }

  function parseMetaCsv(text) {
    const rows = parseCsvRows(text);
    const headers = rows[0].map(value => value.trim().replace(/^﻿/, ''));
    const index = name => headers.indexOf(name);
    const periodStart = index('Awal pelaporan');
    const periodEnd = index('Akhir pelaporan');
    if (index('Nama kampanye') >= 0 && index('Nama set iklan') >= 0 && index('Nama iklan') >= 0) {
      throw new Error('CSV berisi beberapa level hierarki dan bisa menggandakan belanja. Ekspor campaign, set iklan, atau iklan secara terpisah.');
    }
    const nameIndex = ['Nama kampanye', 'Nama set iklan', 'Nama iklan'].map(index).find(value => value >= 0);
    const spendIndex = index('Jumlah yang dibelanjakan (IDR)');
    if ([periodStart, periodEnd, nameIndex, spendIndex].some(value => value < 0)) {
      throw new Error('Header CSV tidak dikenali. Perlu kolom tanggal, nama campaign/set/iklan, dan “Jumlah yang dibelanjakan (IDR)”.');
    }
    const reachIndex = index('Jangkauan');
    const impressionsIndex = index('Impresi');
    const clicksIndex = index('Klik tautan');
    const resultsIndex = index('Hasil');
    const resultTypeIndex = index('Indikator Hasil');
    const names = ['Nama kampanye', 'Nama set iklan', 'Nama iklan'];
    const presentNames = names.filter(name => headers.includes(name));
    if (presentNames.length !== 1) throw new Error('CSV harus berisi tepat satu level nama: campaign, set iklan, atau iklan. Ekspor tiap level secara terpisah.');
    const entityName = presentNames[0];
    const campaigns = [];
    let since = null;
    let until = null;
    for (const [rowIndex, row] of rows.slice(1).entries()) {
      const rowSince = row[periodStart].trim();
      const rowUntil = row[periodEnd].trim();
      if (!isDate(rowSince) || !isDate(rowUntil) || rowSince > rowUntil) {
        throw new Error(`Tanggal tidak valid pada baris ${rowIndex + 2}.`);
      }
      if (since && (rowSince !== since || rowUntil !== until)) throw new Error('Satu impor CSV harus memiliki satu rentang tanggal yang konsisten.');
      since = rowSince;
      until = rowUntil;
      const metric = column => column < 0 ? null : parseLocalizedNumber(row[column]);
      const spend = metric(spendIndex);
      if (spend === null || spend < 0) throw new Error(`Spend tidak valid pada baris ${rowIndex + 2}.`);
      const rawType = resultTypeIndex >= 0 ? row[resultTypeIndex].trim() : '';
      const resultType = normalizeResultType(rawType);
      campaigns.push({
        id: `csv-row-${rowIndex + 1}`,
        name: row[nameIndex].trim() || `Baris ${rowIndex + 2}`,
        status: headers.includes('Penayangan iklan') ? row[index('Penayangan iklan')].trim().toUpperCase() : 'UNKNOWN',
        spend,
        reach: metric(reachIndex),
        impressions: metric(impressionsIndex),
        linkClicks: metric(clicksIndex),
        results: metric(resultsIndex),
        resultType,
      });
    }
    if (!campaigns.length) throw new Error('CSV tidak berisi baris data.');
    return normalizeSnapshot({
      schemaVersion: SNAPSHOT_VERSION,
      accountName: 'Aseta - Ads',
      currency: 'IDR',
      period: { since, until },
      fetchedAt: new Date().toISOString(),
      source: 'csv-import',
      entityLevel: entityName.includes('Nama kampanye') ? 'campaign' : entityName.includes('Nama set iklan') ? 'adset' : 'ad',
      campaigns,
    });
  }

  function loadStoredSupabaseConfig() {
    try { return JSON.parse(localStorage.getItem(SUPABASE_CONFIG_KEY) || 'null'); } catch { return null; }
  }

  function loadStoredSupabaseSession() {
    try { return JSON.parse(localStorage.getItem(SUPABASE_SESSION_KEY) || 'null'); } catch { return null; }
  }

  function loadFunnel() {
    try {
      const raw = localStorage.getItem(FUNNEL_KEY);
      return raw ? normalizeFunnel(JSON.parse(raw)) : { schemaVersion: FUNNEL_VERSION, entries: [] };
    } catch (error) {
      return { schemaVersion: FUNNEL_VERSION, entries: [], error: error.message || 'Penyimpanan browser tidak tersedia.' };
    }
  }

  function saveFunnel(data) {
    const funnel = normalizeFunnel(data);
    try {
      localStorage.setItem(FUNNEL_KEY, JSON.stringify(funnel));
      return funnel;
    } catch {
      throw new Error('Penyimpanan browser penuh atau tidak tersedia. Data belum disimpan; ekspor backup sebelum menutup halaman.');
    }
  }

  function formatNumber(value, maximumFractionDigits = 0) {
    return Number.isFinite(value)
      ? new Intl.NumberFormat('id-ID', { maximumFractionDigits }).format(value)
      : '—';
  }

  function formatMoney(value) {
    return Number.isFinite(value) ? `Rp ${formatNumber(value)}` : '—';
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date(`${date}T00:00:00`));
  }

  function tuesdayWeekRange(date) {
    const [year, month, day] = date.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, day));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 5) % 7));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return {
      since: start.toISOString().slice(0, 10),
      until: end.toISOString().slice(0, 10),
    };
  }

  function analyzeOrganicContent(contents) {
    const scores = contents.map(item => {
      const { likes, comments } = item.organic ?? {};
      return Number.isFinite(likes) && Number.isFinite(comments) ? likes + comments : null;
    });
    const known = scores.filter(Number.isFinite).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor((known.length - 1) / 2)] : null;
    const relevant = item => /asset|aset|rfid|maintenance|pemeliharaan|stock opname|depresiasi|inventaris|qr code/i.test(item.caption);

    return contents.map((item, index) => {
      const engagement = scores[index];
      const isRelevant = relevant(item);
      if (engagement === null) {
        return { label: 'Belum cukup data', reason: 'Like/komentar belum tersedia; potensi engagement dan hasil iklan belum bisa dinilai.' };
      }
      if (isRelevant && (known.length === 1 || engagement > median)) {
        return { label: 'Kandidat uji iklan', reason: `Caption relevan dengan manajemen aset dan ${engagement} like + komentar; interaksi di atas median konten yang datanya tersedia (${median}). Layak diuji, bukan jaminan hasil iklan.` };
      }
      if (isRelevant) {
        return { label: 'Relevan — pantau', reason: `Caption relevan dengan manajemen aset, tetapi ${engagement} like + komentar belum di atas median (${median}); belum ada sinyal kuat untuk diprioritaskan.` };
      }
      if (known.length > 1 && engagement > median) {
        return { label: 'Interaksi tinggi — cek relevansi', reason: `${engagement} like + komentar di atas median (${median}), tetapi relevansi dengan manajemen aset tidak terdeteksi dari caption.` };
      }
      return { label: 'Belum diprioritaskan', reason: `${engagement} like + komentar; belum ada sinyal relevansi dan engagement relatif yang cukup untuk shortlist.` };
    });
  }

  function buildWeeklySnapshot(snapshot) {
    const days = new Map();
    for (const day of snapshot.dailyMetrics ?? []) {
      const week = tuesdayWeekRange(day.date);
      const entry = days.get(week.since) ?? { ...week, campaigns: new Map(), dates: new Set() };
      entry.dates.add(day.date);
      for (const metric of day.campaigns ?? []) {
        const normalizedMetric = metric.results === null && metric.spend === 0
          ? { ...metric, results: 0 }
          : metric;
        const current = entry.campaigns.get(normalizedMetric.id);
        if (!current) {
          entry.campaigns.set(normalizedMetric.id, { ...normalizedMetric });
          continue;
        }
        for (const field of ['spend', 'reach', 'impressions', 'linkClicks', 'results']) {
          current[field] = Number.isFinite(current[field]) && Number.isFinite(normalizedMetric[field])
            ? current[field] + normalizedMetric[field] : null;
        }
        if (current.resultType !== normalizedMetric.resultType) current.resultType = null;
      }
      days.set(week.since, entry);
    }
    return [...days.values()].sort((a, b) => a.since.localeCompare(b.since)).map(week => {
      const expectedDays = Math.round((Date.parse(`${week.until}T00:00:00Z`) - Date.parse(`${week.since}T00:00:00Z`)) / 86400000) + 1;
      const campaignData = [...week.campaigns.values()];
      const byResultType = {};
      for (const type of ['MESSAGING_CONVERSATION', 'LEAD']) {
        const matching = campaignData.filter(item => item.resultType === type);
        const completeResults = matching.length > 0 && matching.every(item => Number.isFinite(item.results));
        byResultType[type] = completeResults
          ? {
            spend: matching.reduce((sum, item) => sum + (item.spend ?? 0), 0),
            results: matching.reduce((sum, item) => sum + item.results, 0),
            costPerResult: matching.reduce((sum, item) => sum + (item.spend ?? 0), 0) / matching.reduce((sum, item) => sum + item.results, 0),
          }
          : null;
      }
      return {
        since: week.since,
        until: week.until,
        days: week.dates.size,
        complete: week.dates.size === expectedDays,
        byResultType,
        campaigns: campaignData,
      };
    });
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function init(document) {
    const byId = id => document.getElementById(id);
    const status = byId('status-message');
    const snapshotInput = byId('snapshot-file');
    const csvInput = byId('csv-file');
    const funnelInput = byId('funnel-file');
    const importCsvButton = byId('import-csv-button');
    const confirmCsvButton = byId('confirm-csv-button');
    const confirmFunnelButton = byId('confirm-funnel-button');
    const useSnapshotButton = byId('use-snapshot-button');
    const funnelForm = byId('funnel-form');
    const demoToggle = byId('demo-toggle');
    const importSnapshotButton = byId('import-snapshot-button');
    const funnelToggle = byId('funnel-toggle');
    const funnelLayout = document.querySelector('.funnel-layout');
    const weekControls = byId('week-controls');
    const weekSelect = byId('week-select');
    const contentPlatformFilter = byId('content-platform-filter');
    const contentStatusFilter = byId('content-status-filter');
    const contentFormatFilter = byId('content-format-filter');
    const contentPagination = byId('content-pagination');
    const contentPageLabel = byId('content-page-label');
    const contentPrevPage = byId('content-prev-page');
    const contentNextPage = byId('content-next-page');
    let contentPage = 1;
    let activeSnapshot = null;
    let pendingCsv = null;
    let pendingFunnel = null;
    let funnel = loadFunnel();
    let supabaseConfig = getSupabaseConfig(loadStoredSupabaseConfig());
    let supabaseSession = loadStoredSupabaseSession();
    let supabaseClient = null;
    let funnelStorageMode = 'local';
    let lastCsvFilename = 'meta-ads-export.csv';
    let lastLocalSnapshotTimestamp = null;
    let selectedWeek = null;
    const localSnapshotPollMs = 5000;

    function announce(message, isError = false) {
      status.textContent = message;
      status.classList.toggle('status-error', isError);
    }

    function setFunnelSyncStatus(message, isError = false) {
      const target = byId('funnel-sync-status');
      target.textContent = message;
      target.classList.toggle('status-error', isError);
    }

    function saveSupabaseConfig(config) {
      const nextConfig = getSupabaseConfig(config);
      if (!nextConfig) throw new Error('Masukkan URL proyek Supabase HTTPS dan publishable/anon key yang valid. Jangan gunakan service_role key.');
      localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(nextConfig));
      supabaseConfig = nextConfig;
      supabaseClient = null;
    }

    async function getSupabaseClient() {
      if (!supabaseConfig) throw new Error('Konfigurasi Supabase belum disimpan.');
      if (supabaseClient) return supabaseClient;
      const client = window.supabase?.createClient;
      if (!client) throw new Error('Library Supabase belum tersedia; periksa koneksi internet lalu muat ulang halaman.');
      supabaseClient = client(supabaseConfig.url, supabaseConfig.anonKey, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true } });
      return supabaseClient;
    }

    async function restoreSupabaseSession() {
      if (!supabaseConfig || !supabaseSession?.access_token) return false;
      const client = await getSupabaseClient();
      const { data, error } = await client.auth.setSession({ access_token: supabaseSession.access_token, refresh_token: supabaseSession.refresh_token });
      if (error) throw error;
      supabaseSession = data.session;
      localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(supabaseSession));
      return Boolean(data.session?.user?.id);
    }

    async function loadPrivateFunnel() {
      const client = await getSupabaseClient();
      const { data: userResult, error: userError } = await client.auth.getUser();
      if (userError || !userResult.user) throw new Error('Sesi masuk tidak berlaku. Silakan masuk kembali.');
      const { data, error } = await client.from(SUPABASE_TABLE).select('*');
      if (error) throw error;
      const remoteFunnel = normalizeFunnel({ schemaVersion: FUNNEL_VERSION, entries: (data ?? []).map(funnelRecordToEntry) });
      funnel = remoteFunnel;
      funnelStorageMode = 'remote';
      renderFunnel();
      setFunnelSyncStatus(`Penyimpanan privat aktif · ${userResult.user.email ?? 'akun masuk'}`);
    }

    async function savePrivateFunnel(nextFunnel) {
      const client = await getSupabaseClient();
      const { data: userResult, error: userError } = await client.auth.getUser();
      if (userError || !userResult.user) throw new Error('Sesi masuk tidak berlaku. Silakan masuk kembali.');
      const userId = userResult.user.id;
      const records = normalizeFunnel(nextFunnel).entries.map(entry => {
        const row = funnelEntryToRecord(entry, userId);
        delete row.user_id;
        return row;
      });
      const { error } = await client.rpc('replace_my_funnel', { entries: records });
      if (error) throw error;
      funnel = normalizeFunnel(nextFunnel);
      funnelStorageMode = 'remote';
      renderFunnel();
      setFunnelSyncStatus(`Tersimpan privat · ${userResult.user.email ?? 'akun masuk'}`);
    }

    function showNumber(id, value, suffix = '') {
      byId(id).textContent = value === null || value === undefined ? '—' : `${formatNumber(value)}${suffix}`;
    }

    function renderFunnel() {
      const body = byId('funnel-table-body');
      body.replaceChildren();
      const entries = activeSnapshot
        ? funnel.entries.filter(entry => entry.periodSince === activeSnapshot.period.since && entry.periodUntil === activeSnapshot.period.until)
        : funnel.entries;
      byId('funnel-record-count').textContent = `${entries.length} catatan${activeSnapshot ? ' untuk periode ini' : ''}`;
      if (!entries.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'empty-cell';
        cell.textContent = 'Belum ada data funnel untuk periode ini. Pilih campaign dan isi form di atas.';
        row.append(cell);
        body.append(row);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('tr');
        const qualifiedToMeeting = safeRate(entry.meetingsScheduled, entry.qualifiedLeads);
        const meetingAttendance = safeRate(entry.meetingsAttended, entry.meetingsScheduled);
        const qualifiedToDeal = normalizeFunnelDealRate(entry);
        const values = [entry.campaignName, formatNumber(entry.qualifiedLeads), formatNumber(entry.meetingsScheduled), formatNumber(entry.meetingsAttended), formatNumber(entry.dealsClosed), `${entry.outcomeNote || '—'}${qualifiedToMeeting === null ? '' : ` · Qual→meeting ${formatNumber(qualifiedToMeeting * 100, 1)}%`}${meetingAttendance === null ? '' : ` · hadir ${formatNumber(meetingAttendance * 100, 1)}%`}${qualifiedToDeal === null ? '' : ` · Qual→deal ${formatNumber(qualifiedToDeal * 100, 1)}%`}`];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        const actions = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-small';
        button.textContent = 'Edit';
        button.setAttribute('aria-label', `Edit funnel ${entry.campaignName}`);
        button.addEventListener('click', () => populateFunnelForm(entry));
        actions.append(button);
        row.append(actions);
        body.append(row);
      }
    }

    function renderContentAnalysis(contents) {
      const section = byId('content-analysis-section');
      section.hidden = !contents.length;
      const statusCounts = contents.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {});
      byId('content-status-summary').textContent = `${contents.length} konten · ${statusCounts.PROMOTE ?? 0} PROMOTE · ${statusCounts.TEST ?? 0} TEST`;
      const filtered = contents.filter(item => (contentPlatformFilter.value === 'all' || item.platform === contentPlatformFilter.value)
        && (contentStatusFilter.value === 'all' || item.status === contentStatusFilter.value)
        && (contentFormatFilter.value === 'all' || item.mediaType === contentFormatFilter.value));
      const pageCount = Math.ceil(filtered.length / CONTENT_PAGE_SIZE);
      contentPage = Math.min(contentPage, Math.max(1, pageCount));
      contentPagination.hidden = filtered.length <= CONTENT_PAGE_SIZE;
      contentPageLabel.textContent = filtered.length ? `Halaman ${contentPage} dari ${pageCount} · ${filtered.length} konten` : '0 konten';
      contentPrevPage.disabled = contentPage <= 1;
      contentNextPage.disabled = contentPage >= pageCount;
      const pageStart = (contentPage - 1) * CONTENT_PAGE_SIZE;
      const pageItems = filtered.slice(pageStart, pageStart + CONTENT_PAGE_SIZE);
      const insights = analyzeOrganicContent(contents);
      const insightById = new Map(contents.map((item, index) => [item.contentId, insights[index]]));
      const body = byId('content-table-body');
      body.replaceChildren();
      for (const item of pageItems) {
        const row = document.createElement('tr');
        const values = [item.platform, item.publishedAt ? formatDate(item.publishedAt.slice(0, 10)) : '—', item.mediaType, `${formatNumber(item.organic.likes)} / ${formatNumber(item.organic.comments)}`, item.caption.split('\\n')[0].slice(0, 100)];
        for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        const insight = insightById.get(item.contentId);
        const insightCell = document.createElement('td');
        const label = document.createElement('strong');
        label.textContent = insight.label;
        const reason = document.createElement('p');
        reason.className = 'content-insight-reason';
        reason.textContent = insight.reason;
        insightCell.append(label, reason);
        row.append(insightCell);
        const linkCell = document.createElement('td');
        if (item.permalink) { const link = document.createElement('a'); link.href = item.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Buka'; linkCell.append(link); } else linkCell.textContent = '—';
        row.append(linkCell); body.append(row);
      }
      if (!filtered.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 7; cell.className = 'empty-cell'; cell.textContent = 'Tidak ada konten dengan filter ini.'; row.append(cell); body.append(row); }
    }

    function renderAnalysis(analysis) {
      const section = byId('analysis-section');
      section.hidden = !analysis;
      byId('analysis-summary').textContent = analysis?.summary ?? '';
      byId('analysis-good').textContent = analysis ? (analysis.campaigns.find(item => item.label === 'strongest')?.reason ?? analysis.facts[0] ?? 'Belum ada temuan positif yang cukup kuat.') : '—';
      byId('analysis-watch').textContent = analysis ? (analysis.findings[0] ?? analysis.limitations[0] ?? 'Tidak ada hal khusus yang perlu ditinjau.') : '—';
      byId('analysis-next').textContent = analysis ? (analysis.recommendations[0] ?? 'Belum ada saran tindakan spesifik.') : '—';
      byId('analysis-generated-at').textContent = analysis?.generatedAt
        ? `Dianalisis ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(analysis.generatedAt))}`
        : '';
      const fillList = (id, values) => {
        const list = byId(id);
        list.replaceChildren();
        for (const value of values) {
          const item = document.createElement('li');
          item.textContent = value;
          list.append(item);
        }
      };
      if (!analysis) return;
      fillList('analysis-facts', analysis.facts);
      fillList('analysis-findings', analysis.findings);
      fillList('analysis-recommendations', analysis.recommendations);
      fillList('analysis-limitations', analysis.limitations);
      const hasDetails = analysis.facts.length || analysis.findings.length || analysis.recommendations.length || analysis.limitations.length || analysis.campaigns.length;
      byId('analysis-empty').hidden = Boolean(analysis.summary || hasDetails);
      byId('analysis-campaign-section').hidden = !analysis.campaigns.length;
      const campaignList = byId('analysis-campaign-list');
      campaignList.replaceChildren();
      const labelText = { strongest: 'Relatif lebih efisien', 'needs-attention': 'Perlu ditinjau', 'not-comparable': 'Tidak dibandingkan' };
      for (const item of analysis.campaigns) {
        const card = document.createElement('article');
        card.className = 'analysis-campaign-card';
        const badge = document.createElement('span');
        badge.className = `analysis-label analysis-label-${item.label}`;
        badge.textContent = labelText[item.label];
        const reason = document.createElement('p');
        reason.textContent = item.reason;
        card.append(badge, reason);
        campaignList.append(card);
      }
    }

    function renderRecommendations(recommendations) {
      const list = byId('recommendation-list');
      list.replaceChildren();
      byId('recommendations-section').hidden = !recommendations.length;
      for (const item of recommendations) {
        const article = document.createElement('article');
        article.className = 'recommendation-card';
        const title = document.createElement('h3');
        title.textContent = item.title;
        const claim = document.createElement('p');
        claim.textContent = item.claim;
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Buka rekomendasi di Ads Manager';
        article.append(title, claim, link);
        list.append(article);
      }
    }

    function renderDashboard(snapshot) {
      activeSnapshot = normalizeSnapshot(snapshot);
      const campaignTotals = aggregateCampaigns(activeSnapshot.campaigns);
      const weeks = buildWeeklySnapshot(activeSnapshot);
      const hasWeeklyData = weeks.length > 0;
      const weekControls = byId('week-controls');
      const weekSelect = byId('week-select');
      const weekTrendNote = byId('weekly-trend-note');
      weekControls.hidden = !hasWeeklyData;
      let displayedCampaigns = activeSnapshot.campaigns;
      let displayedPeriod = activeSnapshot.period;
      let totals = activeSnapshot.accountTotals ?? campaignTotals;
      if (hasWeeklyData) {
        weekSelect.replaceChildren();
        for (const week of weeks) {
          const option = document.createElement('option');
          option.value = week.since;
          option.textContent = `${formatDate(week.since)} – ${formatDate(week.until)}`;
          weekSelect.append(option);
        }
        selectedWeek = weeks.some(week => week.since === selectedWeek) ? selectedWeek : weeks[weeks.length - 1].since;
        weekSelect.value = selectedWeek;
        const weekIndex = weeks.findIndex(item => item.since === selectedWeek);
        const week = weeks[weekIndex];
        const previousWeek = weeks[weekIndex - 1];
        displayedCampaigns = week.campaigns;
        displayedPeriod = week;
        totals = aggregateCampaigns(displayedCampaigns);
        byId('week-data-note').textContent = `${week.complete ? 'Data 7 hari lengkap' : `Data parsial · ${week.days} hari`} · minggu Selasa–Senin`;
        const weeklyComparisons = week.complete && previousWeek?.complete
          ? compareWeeklyResults(week, previousWeek)
          : [];
        const trendText = weeklyComparisons.length
          ? weeklyComparisons.map(item => `${item.resultType === 'LEAD' ? 'Formulir' : 'Chat'}: ${formatMoney(item.previousCost)} → ${formatMoney(item.currentCost)} (${item.deltaPercent < 0 ? '↓' : '↑'} ${formatNumber(Math.abs(item.deltaPercent), 1)}%)`).join(' · ')
          : 'Tren biaya minggu sebelumnya tidak tersedia (perlu dua minggu penuh dan data lengkap).';
        weekTrendNote.hidden = false;
        weekTrendNote.textContent = trendText;
        week.previous = previousWeek;
        if (weekTrendNote) {
          weekTrendNote.hidden = false;
          weekTrendNote.textContent = trendText;
        }
      } else {
        byId('week-data-note').textContent = 'Data harian belum tersedia; menampilkan seluruh periode.';
        if (weekTrendNote) weekTrendNote.hidden = true;
      }
      const periodText = `${formatDate(displayedPeriod.since)} – ${formatDate(displayedPeriod.until)}`;
      const updatedAt = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activeSnapshot.fetchedAt));
      byId('weekly-data-note').hidden = hasWeeklyData;
      byId('weekly-data-note').textContent = hasWeeklyData ? '' : 'Data per minggu belum tersedia pada snapshot ini. Pilih ekspor harian dari Ads Manager agar periode Selasa–Senin dapat dihitung akurat.';
      byId('period-label').textContent = periodText;
      byId('toolbar-account-name').textContent = activeSnapshot.accountName;
      byId('toolbar-period-label').textContent = periodText;
      byId('updated-at').textContent = updatedAt;
      const sourceLabel = activeSnapshot.source === 'demo' ? 'Data contoh (DEMO)' : activeSnapshot.source === 'meta-read' ? 'Ditarik dari Meta' : activeSnapshot.source === 'csv-import' ? 'Impor CSV' : 'Impor JSON';
      byId('toolbar-source-label').textContent = sourceLabel;
      const scoreLabel = activeSnapshot.opportunityScore === null ? 'Skor peluang Meta tidak disertakan pada snapshot ini.' : `Opportunity Score Meta saat snapshot diambil: ${activeSnapshot.opportunityScore}/100 (tingkat akun, bukan skor tiap campaign).`;
      byId('opportunity-score-note').textContent = activeSnapshot.accountTotals ? `Skor peluang akun: ${activeSnapshot.opportunityScore ?? '—'}/100.` : scoreLabel;
      byId('recommendations-section').hidden = true;
      byId('opportunity-score-note').textContent = 'Rekomendasi Meta tidak ditampilkan di panel analisis AI.';
      const currentWeeklyComparisons = hasWeeklyData && displayedPeriod.complete && displayedPeriod.previous?.complete
        ? compareWeeklyResults(displayedPeriod, displayedPeriod.previous)
        : [];
      const selectedAnalysis = buildDeterministicAnalysis(
        { ...activeSnapshot, period: displayedPeriod, campaigns: displayedCampaigns },
        { funnelEntries: funnel.entries, weeklyComparisons: currentWeeklyComparisons, previousWeek: Boolean(displayedPeriod.previous) },
      );
      renderAnalysis(selectedAnalysis);
      renderContentAnalysis(activeSnapshot.contents);
      const levelLabel = activeSnapshot.entityLevel === 'campaign' ? 'campaign' : activeSnapshot.entityLevel === 'adset' ? 'set iklan' : 'iklan';
      byId('table-level-note').textContent = `Tingkat data: ${levelLabel} · ${activeSnapshot.campaigns.length} baris`;
      byId('campaign-name-heading').textContent = activeSnapshot.entityLevel === 'campaign' ? 'CAMPAIGN' : activeSnapshot.entityLevel === 'adset' ? 'SET IKLAN' : 'IKLAN';
      byId('cpl-heading-note').textContent = 'BIAYA / HASIL';
      byId('funnel-level-help').hidden = activeSnapshot.entityLevel === 'campaign';
      byId('funnel-form').querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = activeSnapshot.entityLevel !== 'campaign'; });
      byId('cpl-heading-note').textContent = 'BIAYA / HASIL';
      showNumber('total-spend', totals.spend);
      showNumber('total-reach', totals.reach);
      showNumber('total-impressions', totals.impressions);
      showNumber('total-clicks', totals.linkClicks);
      showNumber('total-messaging', totals.messagingConversations);
      showNumber('total-form-leads', totals.formLeads);
      byId('total-impressions').textContent = formatNumber(totals.impressions);
      byId('total-clicks').textContent = formatNumber(totals.linkClicks);
      byId('reach-note-detail').textContent = `Terakhir diperbarui ${updatedAt} · Reach di dashboard adalah agregat per campaign, bukan unique Reach akun.`;
      const blendedCost = activeSnapshot.entityLevel === 'campaign' ? totals.blendedCostPerResult : null;
      byId('total-cpl').textContent = formatMoney(blendedCost);
      byId('cpl-note').textContent = activeSnapshot.entityLevel !== 'campaign'
        ? 'Biaya dibagi jumlah hasil sesuai jenis hasil pada baris.'
        : blendedCost === null
          ? 'Perlu belanja dan hasil pesan/form yang lengkap.'
          : `${formatNumber((totals.messagingConversations ?? 0) + (totals.formLeads ?? 0))} percakapan + prospek; biaya mencakup semua campaign.`;
      byId('reach-note').textContent = totals.reach === null ? 'Tidak tersedia' : activeSnapshot.accountTotals ? 'Reach tingkat akun, sesuai ringkasan Meta.' : 'Jumlah reach per campaign; bukan orang unik tingkat akun.';

      const rows = byId('campaign-table-body');
      rows.replaceChildren();
      const campaigns = [...displayedCampaigns].sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
      if (!campaigns.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 9;
        cell.className = 'empty-cell';
        cell.textContent = 'Snapshot ini belum berisi data campaign.';
        row.append(cell);
        rows.append(row);
      }
      campaigns.forEach(campaign => {
        const row = document.createElement('tr');
        const cost = costPerResult(campaign);
        const resultLabel = campaign.results === null ? '—' : `${formatNumber(campaign.results)}${campaign.resultType ? ` · ${campaign.resultType.replaceAll('_', ' ').toLowerCase()}` : ''}`;
        const values = [campaign.name, campaign.status.toLowerCase() === 'active' ? 'Aktif' : campaign.status.toLowerCase() === 'paused' ? 'Jeda' : campaign.status, formatMoney(campaign.spend), resultLabel, formatMoney(cost)];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        rows.append(row);
      });
      byId('campaign-empty').hidden = campaigns.length > 0;
      byId('campaign-table').hidden = campaigns.length === 0;
      byId('campaign-empty').textContent = campaigns.length ? '' : 'Belum ada data campaign untuk periode ini.';
      updateCampaignOptions();
      renderFunnel();
    }

    weekSelect.addEventListener('change', () => {
      selectedWeek = weekSelect.value;
      if (activeSnapshot) renderDashboard(activeSnapshot);
    });
    [contentPlatformFilter, contentStatusFilter, contentFormatFilter].forEach(filter => filter.addEventListener('change', () => {
      contentPage = 1;
      renderContentAnalysis(activeSnapshot?.contents ?? []);
    }));
    contentPrevPage.addEventListener('click', () => {
      if (contentPage > 1) {
        contentPage--;
        renderContentAnalysis(activeSnapshot?.contents ?? []);
      }
    });
    contentNextPage.addEventListener('click', () => {
      contentPage++;
      renderContentAnalysis(activeSnapshot?.contents ?? []);
    });

    function updateCampaignOptions(selectedId = '') {
      const select = byId('funnel-campaign');
      const current = selectedId || select.value;
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = activeSnapshot?.campaigns.length ? 'Pilih campaign' : 'Impor snapshot terlebih dahulu';
      select.append(placeholder);
      for (const campaign of activeSnapshot?.campaigns ?? []) {
        const option = document.createElement('option');
        option.value = campaign.id;
        option.textContent = campaign.name;
        select.append(option);
      }
      if ([...select.options].some(option => option.value === current)) select.value = current;
    }

    function populateFunnelForm(entry) {
      updateCampaignOptions(entry.campaignId);
      byId('funnel-campaign').value = entry.campaignId;
      byId('funnel-since').value = entry.periodSince;
      byId('funnel-until').value = entry.periodUntil;
      byId('qualified-leads').value = entry.qualifiedLeads ?? '';
      byId('meetings-scheduled').value = entry.meetingsScheduled ?? '';
      byId('meetings-attended').value = entry.meetingsAttended ?? '';
      byId('deals-closed').value = entry.dealsClosed ?? '';
      byId('outcome-note').value = entry.outcomeNote;
      byId('funnel-form-title').textContent = 'Edit data funnel';
      byId('funnel-submit').textContent = 'Simpan perubahan';
      byId('funnel-cancel-edit').hidden = false;
      byId('funnel-campaign').focus();
    }

    function resetFunnelForm() {
      funnelForm.reset();
      if (activeSnapshot) {
        byId('funnel-since').value = activeSnapshot.period.since;
        byId('funnel-until').value = activeSnapshot.period.until;
      }
      updateCampaignOptions();
      byId('funnel-form-title').textContent = 'Tambah data funnel';
      byId('funnel-submit').textContent = 'Simpan funnel';
      byId('funnel-cancel-edit').hidden = true;
    }

    async function readJsonFile(file) {
      const value = JSON.parse(await file.text());
      return normalizeSnapshot(value);
    }

    snapshotInput.addEventListener('change', async () => {
      const file = snapshotInput.files?.[0];
      if (!file) return;
      try {
        const snapshot = await readJsonFile(file);
        pendingCsv = null;
        confirmCsvButton.hidden = true;
        useSnapshotButton.hidden = false;
        useSnapshotButton.onclick = () => {
          renderDashboard(snapshot);
          byId('file-preview').textContent = '';
          useSnapshotButton.hidden = true;
          announce(`Snapshot ${file.name} dimuat. Data iklan hanya tersimpan pada halaman ini.`);
        };
        byId('file-preview').textContent = `${snapshot.accountName} · ${formatDate(snapshot.period.since)} – ${formatDate(snapshot.period.until)} · ${snapshot.campaigns.length} baris campaign.`;
        announce('Snapshot tervalidasi. Tinjau ringkasan, lalu pilih “Gunakan snapshot”.');
      } catch (error) {
        pendingCsv = null;
        confirmCsvButton.hidden = true;
        useSnapshotButton.hidden = true;
        byId('file-preview').textContent = '';
        announce(error.message || 'File snapshot tidak dapat dibaca.', true);
      } finally {
        snapshotInput.value = '';
      }
    });

    const authPanel = byId('funnel-auth-panel');
    const authButton = byId('funnel-auth-button');
    const authSignIn = byId('funnel-auth-signin');
    const authSignUp = byId('funnel-auth-signup');
    const authSignOut = byId('funnel-auth-signout');
    const authSaveConfig = byId('funnel-auth-save');
    byId('funnel-supabase-url').value = supabaseConfig?.url ?? '';
    byId('funnel-supabase-key').value = supabaseConfig?.anonKey ?? '';
    authButton.addEventListener('click', () => { authPanel.hidden = !authPanel.hidden; });
    authSaveConfig.addEventListener('click', () => {
      try {
        saveSupabaseConfig({ url: byId('funnel-supabase-url').value, anonKey: byId('funnel-supabase-key').value });
        setFunnelSyncStatus('Konfigurasi tersimpan lokal. Masuk untuk mengaktifkan sinkronisasi privat.');
      } catch (error) { setFunnelSyncStatus(error.message, true); }
    });
    const authenticate = async createAccount => {
      try {
        saveSupabaseConfig({ url: byId('funnel-supabase-url').value, anonKey: byId('funnel-supabase-key').value });
        const client = await getSupabaseClient();
        const credentials = { email: byId('funnel-auth-email').value.trim(), password: byId('funnel-auth-password').value };
        const response = createAccount ? await client.auth.signUp(credentials) : await client.auth.signInWithPassword(credentials);
        if (response.error) throw response.error;
        if (!response.data.session) {
          setFunnelSyncStatus('Akun dibuat. Konfirmasi email dari Supabase dahulu, lalu masuk.');
          return;
        }
        supabaseSession = response.data.session;
        localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(supabaseSession));
        await loadPrivateFunnel();
        authSignOut.hidden = false;
        authSignIn.hidden = true;
        authSignUp.hidden = true;
        authPanel.hidden = true;
        if (funnel.entries.length === 0) {
          const local = loadFunnel();
          if (local.entries.length) setFunnelSyncStatus('Penyimpanan privat aktif. Ada backup lokal yang belum dipindahkan; impor backup funnel untuk memindahkannya.');
        }
      } catch (error) { setFunnelSyncStatus(`Gagal masuk: ${error.message}`, true); }
    };
    authSignIn.addEventListener('click', () => authenticate(false));
    authSignUp.addEventListener('click', () => authenticate(true));
    authSignOut.addEventListener('click', async () => {
      try {
        const client = await getSupabaseClient();
        const { error } = await client.auth.signOut();
        if (error) throw error;
      } catch (error) { setFunnelSyncStatus(`Gagal keluar dari Supabase: ${error.message}`, true); return; }
      localStorage.removeItem(SUPABASE_SESSION_KEY);
      supabaseSession = null;
      funnelStorageMode = 'local';
      funnel = loadFunnel();
      renderFunnel();
      authSignOut.hidden = true;
      authSignIn.hidden = false;
      authSignUp.hidden = false;
      setFunnelSyncStatus('Keluar. Funnel kembali memakai penyimpanan lokal browser.');
    });
    if (supabaseConfig) {
      restoreSupabaseSession().then(active => {
        if (active) {
          authSignIn.hidden = true; authSignUp.hidden = true; authSignOut.hidden = false;
          return loadPrivateFunnel();
        }
        setFunnelSyncStatus('Konfigurasi Supabase tersimpan. Masuk untuk membuka penyimpanan privat.');
      }).catch(error => setFunnelSyncStatus(`Sesi privat tidak dapat dipulihkan: ${error.message}`, true));
    }

    importSnapshotButton.addEventListener('click', () => snapshotInput.click());
    funnelToggle.addEventListener('click', () => {
      funnelLayout.hidden = !funnelLayout.hidden;
      funnelToggle.textContent = funnelLayout.hidden ? 'Isi / lihat funnel' : 'Tutup funnel';
    });
    importCsvButton.addEventListener('click', () => csvInput.click());
    csvInput.addEventListener('change', async () => {
      const file = csvInput.files?.[0];
      if (!file) return;
      try {
        pendingCsv = parseMetaCsv(await file.text());
        lastCsvFilename = file.name;
        byId('file-preview').textContent = `${pendingCsv.accountName} · ${formatDate(pendingCsv.period.since)} – ${formatDate(pendingCsv.period.until)} · ${pendingCsv.campaigns.length} baris campaign.`;
        confirmCsvButton.hidden = false;
        useSnapshotButton.hidden = true;
        announce('CSV tervalidasi. Pastikan periode dan jumlah campaign benar, lalu pilih “Gunakan data ini”.');
      } catch (error) {
        pendingCsv = null;
        confirmCsvButton.hidden = true;
        announce(error.message || 'CSV tidak dapat dibaca.', true);
      } finally {
        csvInput.value = '';
      }
    });

    confirmCsvButton.addEventListener('click', () => {
      if (!pendingCsv) return;
      renderDashboard(pendingCsv);
      pendingCsv = null;
      confirmCsvButton.hidden = true;
      byId('file-preview').textContent = '';
      announce(`Data dari ${lastCsvFilename} dimuat ke halaman ini. File CSV tidak diunggah atau disimpan.`);
    });

    byId('funnel-campaign').addEventListener('change', () => {
      const campaign = activeSnapshot?.campaigns.find(item => item.id === byId('funnel-campaign').value);
      if (campaign && activeSnapshot) {
        const existing = funnel.entries.find(entry => entry.campaignId === campaign.id && entry.periodSince === activeSnapshot.period.since && entry.periodUntil === activeSnapshot.period.until);
        if (existing) {
          populateFunnelForm(existing);
        } else {
          byId('funnel-since').value = activeSnapshot.period.since;
          byId('funnel-until').value = activeSnapshot.period.until;
        }
      }
    });

    funnelForm.addEventListener('submit', async event => {
      event.preventDefault();
      const campaign = activeSnapshot?.campaigns.find(item => item.id === byId('funnel-campaign').value);
      if (!campaign) return announce('Pilih campaign dari snapshot yang aktif.', true);
      const entry = {
        campaignId: campaign.id,
        campaignName: campaign.name,
        periodSince: byId('funnel-since').value,
        periodUntil: byId('funnel-until').value,
        qualifiedLeads: byId('qualified-leads').value === '' ? null : Number(byId('qualified-leads').value),
        meetingsScheduled: byId('meetings-scheduled').value === '' ? null : Number(byId('meetings-scheduled').value),
        meetingsAttended: byId('meetings-attended').value === '' ? null : Number(byId('meetings-attended').value),
        dealsClosed: byId('deals-closed').value === '' ? null : Number(byId('deals-closed').value),
        outcomeNote: byId('outcome-note').value.trim().slice(0, 500),
      };
      try {
        const next = mergeManualFunnel(funnel, [entry]);
        if (funnelStorageMode === 'remote') await savePrivateFunnel(next);
        else { funnel = saveFunnel(next); renderFunnel(); }
        resetFunnelForm();
        announce(funnelStorageMode === 'remote' ? 'Data funnel tersimpan di penyimpanan privat.' : 'Data funnel tersimpan di penyimpanan browser perangkat ini.');
      } catch (error) {
        announce(error.message, true);
        setFunnelSyncStatus(`Penyimpanan gagal: ${error.message}`, true);
      }
    });

    byId('funnel-cancel-edit').addEventListener('click', resetFunnelForm);
    byId('export-funnel').addEventListener('click', () => {
      const backup = { schemaVersion: 1, exportedAt: new Date().toISOString(), funnel };
      downloadJson(`aseta-funnel-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
      announce('Backup funnel diekspor. Simpan file ini dengan aman; di dalamnya ada catatan funnel manual.');
    });

    byId('import-funnel-button').addEventListener('click', () => funnelInput.click());
    funnelInput.addEventListener('change', async () => {
      const file = funnelInput.files?.[0];
      if (!file) return;
      try {
        const backup = JSON.parse(await file.text());
        if (backup.schemaVersion !== 1 || !validTimestamp(backup.exportedAt)) throw new Error('Format backup funnel tidak valid.');
        pendingFunnel = normalizeFunnel(backup.funnel);
        byId('funnel-preview').textContent = `Backup berisi ${pendingFunnel.entries.length} baris. Konfirmasi untuk menggabungkan; baris campaign/periode yang sama akan diperbarui.`;
        confirmFunnelButton.hidden = false;
        announce('Backup funnel tervalidasi. Konfirmasi penggabungan sebelum menyimpan.');
      } catch (error) {
        pendingFunnel = null;
        confirmFunnelButton.hidden = true;
        announce(error.message || 'Backup funnel tidak dapat dibaca.', true);
      } finally {
        funnelInput.value = '';
      }
    });

    confirmFunnelButton.addEventListener('click', async () => {
      if (!pendingFunnel) return;
      try {
        const next = mergeManualFunnel(funnel, pendingFunnel.entries);
        if (funnelStorageMode === 'remote') await savePrivateFunnel(next);
        else { funnel = saveFunnel(next); renderFunnel(); }
        pendingFunnel = null;
        confirmFunnelButton.hidden = true;
        byId('funnel-preview').textContent = '';
        announce(funnelStorageMode === 'remote' ? 'Backup berhasil digabung ke penyimpanan privat.' : 'Backup berhasil digabungkan ke penyimpanan browser.');
      } catch (error) {
        announce(error.message, true);
      }
    });

    demoToggle.addEventListener('click', () => {
      const demo = {
        schemaVersion: 1, accountName: 'Aseta - Ads (DEMO)', currency: 'IDR',
        period: { since: '2026-08-01', until: '2026-08-28' },
        fetchedAt: '2026-08-29T03:00:00.000Z', source: 'demo',
        campaigns: [
          { id: 'demo-lead', name: 'Contoh campaign — Lead (DEMO)', status: 'ACTIVE', spend: 1250000, reach: 15600, impressions: 28400, linkClicks: 672, results: 24, resultType: 'LEAD' },
          { id: 'demo-message', name: 'Contoh campaign — Pesan (DEMO)', status: 'PAUSED', spend: 540000, reach: 7200, impressions: 11900, linkClicks: 201, results: 9, resultType: 'MESSAGING_CONVERSATION' },
        ],
      };
      renderDashboard(demo);
      announce('Mode DEMO aktif. Angka yang ditampilkan fiktif dan bukan data akun.');
    });

    funnel = funnel.error ? { schemaVersion: 1, entries: [] } : funnel;
    renderFunnel();
    updateCampaignOptions();
    byId('funnel-since').value = '';
    byId('funnel-until').value = '';
    if (window.location.protocol === 'file:') {
      announce('Dashboard siap. Pilih “Impor snapshot JSON terbaru” untuk memuat data Meta, atau gunakan contoh DEMO.');
    } else {
      const loadLocalSnapshot = (announceLoaded = false) => fetch(`data/meta-snapshot.json?ts=${Date.now()}`, { cache: 'no-store' })
        .then(response => {
          if (!response.ok) throw new Error('Belum ada snapshot tersimpan.');
          return response.json();
        })
        .then(snapshot => {
          const normalized = normalizeSnapshot(snapshot);
          if (lastLocalSnapshotTimestamp === normalized.fetchedAt) return false;
          const hadSnapshot = Boolean(activeSnapshot);
          renderDashboard(normalized);
          lastLocalSnapshotTimestamp = normalized.fetchedAt;
          if (announceLoaded || hadSnapshot) announce('Snapshot lokal dimuat dan diperbarui otomatis.');
          return true;
        });
      loadLocalSnapshot().catch(() => announce('Belum ada snapshot lokal. Minta asisten menarik data, lalu impor JSON, atau impor CSV.'));
      window.setInterval(() => {
        loadLocalSnapshot().catch(() => {});
      }, localSnapshotPollMs);
    }
  }

  return {
    parseLocalizedNumber,
    safeRate,
    escapeHtml,
    normalizeSnapshot,
    aggregateCampaigns,
    compareWeeklyResults,
    costPerResult,
    normalizeFunnel,
    mergeManualFunnel,
    parseCsvRows,
    parseMetaCsv,
    tuesdayWeekRange,
    buildWeeklySnapshot,
    normalizeFunnel,
    normalizeFunnelDealRate,
    loadFunnel,
    saveFunnel,
    normalizeAnalysis,
    analyzeOrganicContent,
    buildDeterministicAnalysis,
    init,
  };
});
