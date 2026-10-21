import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH_VERSION = "v24.0";
const MAX_DAYS = 28;
const MAX_AD_SETS = 200;

type ResultType = "MESSAGING_CONVERSATION" | "LEAD";
type Metric = {
  spend: number | null;
  results: number | null;
  costPerResult: number | null;
};
type AdSet = {
  adSetId: string;
  adSetName: string;
  campaignId: string;
  campaignName: string;
  objective: string | null;
  targeting: {
    locations: {
      included: Array<{ name: string; type: string; key: string }>;
      excluded: Array<{ name: string; type: string; key: string }>;
      javaCoverage: "includes" | "excludes" | "not-targeted" | "unknown";
    } | null;
    ageMin: number | null;
    ageMax: number | null;
    genders: number[] | null;
    interests: { count: number | null; hasCustomAudiences: boolean } | null;
  };
  metricsByResultType: Partial<Record<ResultType, Metric>>;
  dataCoverage: string[];
};

type FunnelRow = {
  campaign_id: string;
  campaign_name: string;
  period_since: string;
  period_until: string;
  qualified_leads: number | null;
  meetings_scheduled: number | null;
  meetings_attended: number | null;
  deals_closed: number | null;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, payload: unknown, origin: string) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...jsonHeaders,
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "vary": "Origin",
    },
  });
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}

export function validateRange(
  body: unknown,
  today = new Date().toISOString().slice(0, 10),
) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { since, until, ...extra } = body as Record<string, unknown>;
  if (
    Object.keys(extra).length || !isDate(since) || !isDate(until) ||
    since > until || until >= today
  ) return null;
  const days =
    (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
      86400000 + 1;
  return days >= 1 && days <= MAX_DAYS ? { since, until } : null;
}

function getLocationItems(input: Record<string, unknown> | undefined) {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([type, items]) =>
    Array.isArray(items)
      ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object"
      )
        .map((item) => ({
          name: String(
            item.name ?? item.region ?? item.country ?? item.key ??
              "Unknown location",
          ),
          type,
          key: String(item.key ?? ""),
        }))
      : []
  );
}

export function normalizeTargeting(
  targeting: Record<string, unknown> | null | undefined,
) {
  if (!targeting || typeof targeting !== "object") {
    return {
      locations: null,
      ageMin: null,
      ageMax: null,
      genders: null,
      interests: null,
    };
  }
  const included = getLocationItems(
    targeting.geo_locations as Record<string, unknown> | undefined,
  );
  const excluded = getLocationItems(
    targeting.excluded_geo_locations as Record<string, unknown> | undefined,
  );
  const all = [...included, ...excluded];
  const javaLocations = all.filter((location) =>
    /jawa|java/i.test(`${location.name} ${location.key}`)
  );
  const javaCoverage: "includes" | "excludes" | "not-targeted" | "unknown" =
    javaLocations.some((x) =>
        included.some((y) => y.name === x.name && y.key === x.key)
      )
      ? "includes"
      : javaLocations.length
      ? "excludes"
      : all.length
      ? "not-targeted"
      : "unknown";
  const detailed = Array.isArray(targeting.flexible_spec)
    ? targeting.flexible_spec
    : [];
  const interestCount = detailed.reduce(
    (sum, group) =>
      sum + (Array.isArray(group?.interests) ? group.interests.length : 0),
    0,
  );
  const hasCustomAudiences = Boolean(
    targeting.custom_audiences || targeting.excluded_custom_audiences,
  );
  return {
    locations: { included, excluded, javaCoverage },
    ageMin: Number.isFinite(targeting.age_min)
      ? Number(targeting.age_min)
      : null,
    ageMax: Number.isFinite(targeting.age_max)
      ? Number(targeting.age_max)
      : null,
    genders: Array.isArray(targeting.genders)
      ? targeting.genders.filter(Number.isFinite).map(Number)
      : null,
    interests: { count: interestCount, hasCustomAudiences },
  };
}

export function normalizeInsights(rows: Array<Record<string, unknown>>) {
  const groups = new Map<string, Record<string, Metric>>();
  for (const row of rows) {
    const adSetId = String(row.adset_id ?? "");
    if (!adSetId) continue;
    const actions = Array.isArray(row.actions)
      ? row.actions as Array<Record<string, unknown>>
      : [];
    const byType = groups.get(adSetId) ?? {};
    const spend = Number.isFinite(Number(row.spend)) ? Number(row.spend) : null;
    for (const action of actions) {
      const actionType = String(action.action_type ?? "");
      const resultType: ResultType | null =
        actionType.includes("messaging_conversation_started")
          ? "MESSAGING_CONVERSATION"
          : actionType === "leadgen.other"
          ? "LEAD"
          : null;
      if (!resultType) continue;
      const results = Number.isFinite(Number(action.value))
        ? Number(action.value)
        : null;
      const previous = byType[resultType];
      byType[resultType] = {
        spend: (previous?.spend ?? 0) + (spend ?? 0),
        results: results === null ? null : (previous?.results ?? 0) + results,
        costPerResult: null,
      };
    }
    if (Object.keys(byType).length) groups.set(adSetId, byType);
  }
  for (const byType of groups.values()) {
    for (const metrics of Object.values(byType)) {
      metrics.costPerResult =
        metrics.spend !== null && metrics.results !== null &&
          metrics.results > 0
          ? metrics.spend / metrics.results
          : null;
    }
  }
  return groups;
}

async function graphGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", token);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = Number((payload as any)?.error?.code);
    const error = new Error("Meta API request failed") as Error & {
      safeCode?: string;
    };
    error.safeCode = code === 4 || code === 17 || code === 32
      ? "META_RATE_LIMIT"
      : "META_API_ERROR";
    throw error;
  }
  return payload as {
    data?: Array<Record<string, unknown>>;
    paging?: { next?: string };
  };
}

async function fetchAll(
  path: string,
  token: string,
  params: Record<string, string>,
  max: number,
) {
  const rows: Array<Record<string, unknown>> = [];
  let nextPath = path;
  let nextParams = params;
  let truncated = false;
  while (nextPath) {
    const page = await graphGet(nextPath, token, nextParams);
    for (const row of page.data ?? []) {
      if (rows.length === max) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    if (truncated || !page.paging?.next) break;
    const next = new URL(page.paging.next);
    nextPath = next.pathname.replace(/^\//, "");
    nextParams = Object.fromEntries(next.searchParams.entries());
    delete nextParams.access_token;
  }
  return { rows, truncated };
}

async function handleRequest(
  request: Request,
  env: Record<string, string>,
  fetcher = fetch,
) {
  const allowedOrigin = env.ALLOWED_ORIGIN;
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigin || origin !== allowedOrigin) {
    return json(403, { error: "ORIGIN_NOT_ALLOWED" }, allowedOrigin ?? "null");
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-headers": "authorization, apikey, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        "vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") {
    return json(405, { error: "METHOD_NOT_ALLOWED" }, allowedOrigin);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return json(401, { error: "AUTH_REQUIRED" }, allowedOrigin);
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json(503, { error: "SUPABASE_NOT_CONFIGURED" }, allowedOrigin);
  }
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser(
    tokenMatch[1],
  );
  if (authError || !authData.user) {
    return json(401, { error: "INVALID_SESSION" }, allowedOrigin);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_JSON" }, allowedOrigin);
  }
  const range = validateRange(body);
  if (!range) {
    return json(400, {
      error: "INVALID_DATE_RANGE",
      message: "Pilih rentang maksimal 28 hari yang sudah selesai.",
    }, allowedOrigin);
  }
  if (!env.META_ACCESS_TOKEN || !/^\d+$/.test(env.META_AD_ACCOUNT_ID ?? "")) {
    return json(503, { error: "META_NOT_CONFIGURED" }, allowedOrigin);
  }

  try {
    const base = `https://graph.facebook.com/${GRAPH_VERSION}`;
    const metaGet = async (path: string, params: Record<string, string>) => {
      const url = new URL(`${base}/${path}`);
      Object.entries(params).forEach(([key, value]) =>
        url.searchParams.set(key, value)
      );
      url.searchParams.set("access_token", env.META_ACCESS_TOKEN!);
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error("Meta API request failed") as Error & {
          safeCode?: string;
        };
        error.safeCode = Number((result as any)?.error?.code) === 4
          ? "META_RATE_LIMIT"
          : "META_API_ERROR";
        throw error;
      }
      return result as {
        data?: Array<Record<string, unknown>>;
        paging?: { next?: string };
      };
    };
    const fetchPages = async (
      path: string,
      params: Record<string, string>,
      max: number,
    ) => {
      const rows: Array<Record<string, unknown>> = [];
      let page = await metaGet(path, params);
      while (true) {
        for (const row of page.data ?? []) {
          if (rows.length >= max) return { rows, truncated: true };
          rows.push(row);
        }
        if (!page.paging?.next) break;
        const nextUrl = new URL(page.paging.next);
        const nextPath = nextUrl.pathname.replace(/^\//, "");
        const nextParams = Object.fromEntries(nextUrl.searchParams.entries());
        delete nextParams.access_token;
        page = await metaGet(nextPath, nextParams);
      }
      return { rows, truncated: false };
    };
    const [adsetsResult, campaignsResult, insightsResult] = await Promise.all([
      fetchPages(`${env.META_AD_ACCOUNT_ID}/adsets`, {
        fields:
          "id,name,campaign_id,targeting,effective_status,campaign{name,objective}",
        effective_status: '["ACTIVE"]',
        limit: "100",
      }, MAX_AD_SETS),
      fetchPages(`${env.META_AD_ACCOUNT_ID}/campaigns`, {
        fields: "id,name,objective,effective_status",
        effective_status: '["ACTIVE"]',
        limit: "100",
      }, MAX_AD_SETS),
      fetchPages(`${env.META_AD_ACCOUNT_ID}/insights`, {
        fields:
          "adset_id,campaign_id,spend,impressions,reach,inline_link_clicks,actions",
        level: "adset",
        time_increment: "all_days",
        time_range: JSON.stringify({ since: range.since, until: range.until }),
        limit: "500",
      }, 5000),
    ]);
    const campaigns = new Map(
      campaignsResult.rows.map((x) => [String(x.id), x]),
    );
    const insightByAdSet = normalizeInsights(insightsResult.rows);
    const adSets: AdSet[] = adsetsResult.rows.filter((x) =>
      x.effective_status === "ACTIVE"
    ).map((raw) => {
      const adSetId = String(raw.id ?? "");
      const campaignId = String(raw.campaign_id ?? "");
      const targeting = normalizeTargeting(
        raw.targeting as Record<string, unknown> | undefined,
      );
      const metricsByResultType = insightByAdSet.get(adSetId) ?? {};
      const insight = insightsResult.rows.find((row) =>
        String(row.adset_id) === adSetId
      );
      const coverage: string[] = [];
      if (!raw.targeting) coverage.push("Targeting detail unavailable");
      if (!insight) coverage.push("No insight row in selected range");
      if (Object.keys(metricsByResultType).length === 0) {
        coverage.push("No supported messaging/form result type returned");
      }
      return {
        adSetId,
        adSetName: String(raw.name ?? "Ad set"),
        campaignId,
        campaignName: String(
          (raw.campaign as any)?.name ?? campaigns.get(campaignId)?.name ??
            "Campaign",
        ),
        objective: String(
          (raw.campaign as any)?.objective ??
            campaigns.get(campaignId)?.objective ?? "",
        ) || null,
        targeting,
        metricsByResultType,
        dataCoverage: coverage,
      };
    });
    const campaignIds = [
      ...new Set(adSets.map((x) => x.campaignId).filter(Boolean)),
    ];
    const { data: funnelRows, error: funnelError } = await supabase.from(
      "private_funnel_records",
    )
      .select(
        "campaign_id,campaign_name,period_since,period_until,qualified_leads,meetings_scheduled,meetings_attended,deals_closed",
      )
      .in("campaign_id", campaignIds)
      .eq("period_since", range.since)
      .eq("period_until", range.until);
    if (funnelError) {
      return json(502, { error: "FUNNEL_READ_FAILED" }, allowedOrigin);
    }
    const campaignFunnel = (funnelRows ?? []).map((row: FunnelRow) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      scope: "campaign",
      periodSince: row.period_since,
      periodUntil: row.period_until,
      qualifiedLeads: row.qualified_leads,
      meetingsScheduled: row.meetings_scheduled,
      meetingsAttended: row.meetings_attended,
      dealsClosed: row.deals_closed,
    }));
    const limitations = [
      "Funnel quality is campaign-level and cannot be attributed to an individual ad set.",
      "Configured targeting is not proof of who actually saw or converted from an ad.",
    ];
    if (!campaignFunnel.length) {
      limitations.push(
        "No exact-date campaign funnel records found for this selected range.",
      );
    }
    if (
      adsetsResult.truncated || campaignsResult.truncated ||
      insightsResult.truncated
    ) {
      limitations.push(
        "Result set reached the safety cap; coverage may be partial.",
      );
    }
    return json(200, {
      since: range.since,
      until: range.until,
      adSets,
      campaignFunnel,
      coverage: {
        activeAdSets: adSets.length,
        insightsRows: insightsResult.rows.length,
        truncated: adsetsResult.truncated || campaignsResult.truncated ||
          insightsResult.truncated,
      },
      limitations,
    }, allowedOrigin);
  } catch (error) {
    const code = (error as Error & { safeCode?: string }).safeCode ??
      "ANALYSIS_FAILED";
    return json(code === "META_RATE_LIMIT" ? 429 : 502, {
      error: code,
      message:
        "Data Meta tidak dapat dibaca. Periksa izin, token, atau coba lagi nanti.",
    }, allowedOrigin);
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request, Deno.env.toObject()));
}
