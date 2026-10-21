# Audience and Location Analyzer Design

**Date:** 2026-10-21  
**Status:** Proposed for user review; implementation has not started.

## Goal

Add an explicitly user-triggered analyzer that checks active Meta ad sets' audience and location targeting, reports recent lead/message volume, and relates those outcomes to the user's campaign-level Qualified B2B funnel counts. The analyzer must not claim ad-set-level lead quality when funnel records are only campaign-scoped.

## Current Constraints

- The frontend is a public, static GitHub Pages site. Browser code and shipped snapshots are public.
- The currently deployed Meta snapshot contains campaign-level and daily campaign-level metrics, but no ad set targeting, geo locations, or audience definitions.
- Funnel rows are private Supabase records keyed by user, campaign, and date range. They contain aggregate counts only; no lead identities.
- User agreed to put a Meta access token in Supabase Edge Function Secrets. It must never be sent to the browser, repository, GitHub Actions logs, or snapshot JSON.
- No Supabase Edge Function exists in the repository yet.

## Recommended Architecture

1. Dashboard button: **Analisis audience & lokasi**. It is disabled or explains setup requirements if the user is not signed in to Supabase.
2. Browser calls a Supabase Edge Function with the authenticated user's Supabase JWT and a requested reporting range (default to the last 28 complete days; allow a range selector later only if needed). It does not send or receive Meta tokens.
3. Edge Function validates the user JWT, reads the Meta token from server-side Supabase Secrets, and fetches only active ad sets in the configured ad account, including targeting fields (geo locations, age bounds, genders, interests/custom audiences when returned), parent campaign objective/status, and daily results/spend for the requested range.
4. Function reads that user's campaign-level funnel rows for the same period from `private_funnel_records`. It returns an analysis payload without PII, containing ad-set targeting summaries and metrics, campaign-level funnel totals clearly labeled as campaign-scoped, data coverage, and caveats.
5. Frontend renders a per-ad-set table plus a campaign-level quality panel. It compares outcomes among compatible result types only. It may flag whether selected locations include/exclude Java where the API exposes that detail, but must not label locations “good/bad” solely from targeting configuration. It reports actual Qualified B2B/deal results only at campaign level and explicitly says quality cannot be attributed to each ad set.
6. Button activation is the only trigger; no scheduled/background Meta pulls. The result is held in page memory and is not published to GitHub or persisted to public snapshot files.

## Analysis Rules

- Define lead-volume signal from available Meta outcomes: report messaging conversations and instant-form leads separately. Do not add incompatible outcome types into one performance ranking.
- Compare cost only within the same result type and date range. Include spend, results, cost per result, impressions/reach/link clicks if available, and sample-size caveats.
- Audience review describes configured targeting and breadth/control vs suggestion fields as Meta reports them. Do not infer person demographics or actual reach composition from targeting settings alone.
- Location review lists targeted and excluded locations as returned. “Includes Java” is a configuration check, not proof those leads came from Java.
- Funnel quality uses Qualified B2B, meetings, and deals from the user's private campaign/date rows only. Require exact date-range matches; state that the funnel may aggregate other channels if applicable. Never allocate campaign-level quality counts across ad sets.
- Do not recommend budget changes or claim causality from these descriptive comparisons.

## Security and Privacy

- Store Meta token only in Supabase Edge Function Secrets. No token in frontend config, Supabase table, public repo, or logs.
- Require Supabase authentication at the Edge Function; verify JWT server-side and query funnel rows scoped by `auth.uid()`.
- Restrict Edge Function CORS to the exact GitHub Pages origin and validate request fields/range length.
- Return only ad-set targeting/performance details and aggregate campaign funnel counts needed for this view; omit personal data and unnecessary identifiers.
- Treat all response content as untrusted; render via `textContent`, not HTML interpolation.
- Page is public. The button requires login, but anything returned into a browser can be seen by that logged-in user. Do not persist results in the static site or public snapshot.
- Edge Function endpoint is public-addressable by necessity, but rejects unauthenticated requests and applies basic rate limiting; a publishable key is not an access control.

## Setup / Operational Requirements

Before this feature can return live Meta results:

- User creates/owns the Supabase project (already done).
- Run/update the Supabase schema for the function's required reads; verify RLS.
- Deploy the Edge Function from Supabase CLI or Dashboard editor.
- Add the Meta access token and ad account ID as Edge Function Secrets. Credentials must be added directly by the user in Supabase; never request secrets in chat.
- User configures Meta permissions/token lifecycle. Report expiry/permission failures without logging the token.
- Add the exact Pages origin to allowed CORS origins.

## Failure Handling

- Missing token/ad-account secret: return a safe setup message.
- Meta permission/rate-limit/error: return sanitized error code/message; never token or raw request URL.
- Missing targeting fields: label unavailable, do not infer.
- Incomplete/partial metrics: show coverage and suppress comparisons requiring missing values.
- No exact campaign/date funnel match: show “quality data unavailable for this period”; do not silently use another date range.
- Supabase offline: preserve the current local-only funnel behavior and show sync status; analysis request must fail closed rather than fall back to public data.

## Testing

- Unit tests for date-range validation, result-type grouping, missing data, campaign-to-adset attribution limits, location summary, and sanitized error handling.
- Edge Function tests for unauthenticated rejection, user-scoped funnel access, no secret leakage, and Meta API failures.
- Frontend tests for manual trigger, pending/error states, safe rendering, and explicit campaign-level funnel labels.
- Manual integration check with a test Supabase user and Meta token, then verify output is not written to repo/static files.

## Non-Goals for First Version

- Lead-level CRM ingestion or personal data.
- Automatic/scheduled analysis.
- Predictive scoring, causal claims, or automatic budget edits.
- Assigning Qualified B2B outcomes to individual ad sets without a reliable attribution key.
- Persisting analysis output in public GitHub Pages files.
