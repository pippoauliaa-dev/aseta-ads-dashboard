# Audience & Location Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, authenticated analyzer for active Meta ad sets' audience/location targeting and recent results, with campaign-scoped private B2B funnel context.

**Architecture:** Keep GitHub Pages static; route Meta access through an authenticated Supabase Edge Function. The function reads Meta credentials only from server-side Supabase Secrets, reads funnel records under the caller's JWT/RLS, and returns a minimized response. The UI triggers only on button click, holds results in memory, and labels funnel quality as campaign-level, never ad-set attribution.

**Tech Stack:** Existing vanilla JS/HTML/CSS, Supabase JS v2 browser client, Supabase Edge Functions (Deno/TypeScript), Meta Graph API, Supabase Postgres RLS, Node `node:test`, Deno tests.

**Spec:** `docs/superpowers/specs/2026-10-21-audience-location-analyzer-design.md`

## Global Constraints

- The frontend and existing Meta snapshot on GitHub Pages are public.
- Meta access token exists only in Supabase Edge Function Secrets; never browser, repo, GitHub Actions logs, database, or snapshot JSON.
- Analysis runs only on explicit user click; no scheduled pulls.
- Require a valid Supabase user session. Funnel reads are restricted by RLS to `auth.uid()`.
- Use only aggregate campaign/date funnel data; no lead PII.
- Compare results/cost only within compatible result types and identical date ranges.
- Never assign campaign-level funnel quality to individual ad sets.
- No causal claims, prediction, or automatic budget edits.
- Treat API text as untrusted and render via `textContent`.
- Do not persist results in public files or public snapshot data.

---

## File Map

- Modify `app.js`: pure response normalizer, authenticated manual invocation, pending/error states, safe DOM rendering.
- Modify `index.html`: button, date controls, status and results panel.
- Modify `styles.css`: responsive results presentation.
- Create `supabase/functions/analyze-audience-location/index.ts`: auth, bounded Meta requests, scoped funnel query, response sanitizer.
- Create `supabase/functions/analyze-audience-location/index_test.ts`: Deno tests for validation, normalization, auth failures and redaction.
- Create `tests/audience-analysis.test.js`: browser result contract tests.
- Modify `supabase/README.md`: exact deploy/secrets/CORS/Meta-permission steps.
- Do not modify `data/meta-snapshot.json`.

---

## Task 1: Specify and Test the Safe Response Contract

**Files:**
- Create: `tests/audience-analysis.test.js`
- Modify: `app.js`

**Interface:** `summarizeAudienceAnalysis(payload)` returns `{ since, until, adSets, campaignFunnel, coverage, limitations }`. Each ad set has IDs/names needed for campaign association, objective, allowlisted targeting summary, grouped metrics, and coverage flags. Funnel rows remain campaign-level.

- [ ] **Step 1: Write failing tests** for separate messaging/form result groups, null versus zero preservation, campaign-level funnel scope, and dropping unexpected token/PII fields.
- [ ] **Step 2: Run `node --test tests/audience-analysis.test.js`**. Expected: fails because the normalizer is missing. If Node is unavailable, record that and continue test-first without claiming tests ran.
- [ ] **Step 3: Implement the minimal pure `summarizeAudienceAnalysis(payload)` helper** in `app.js`; explicitly allowlist response fields and add the campaign/ad-set attribution limitation.
- [ ] **Step 4: Run `node --test tests/audience-analysis.test.js tests/advanced-analysis.test.js tests/result-type-mapping.test.js`**. Expected: pass.
- [ ] **Step 5: Commit** with `git add app.js tests/audience-analysis.test.js && git commit -m "feat: normalize safe audience analysis results"`.

## Task 2: Build the Authenticated Supabase Edge Function

**Files:**
- Create: `supabase/functions/analyze-audience-location/index.ts`
- Create: `supabase/functions/analyze-audience-location/index_test.ts`

**Interface:** `POST /functions/v1/analyze-audience-location` accepts only `{ since, until }`, valid ISO dates, ordered, at most 28 inclusive days, not future-dated. Response is `{ since, until, adSets, campaignFunnel, coverage, limitations }`.

**Secrets:** `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `ALLOWED_ORIGIN`. Use `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the caller's Authorization header for user-scoped funnel queries. Do not use service-role credentials.

- [ ] **Step 1: Write Deno tests first** for preflight, wrong CORS origin, missing/invalid JWT, malformed/future/overlong ranges, secret-missing response, sanitized errors, and response field allowlisting. Inject/mock `fetch` so tests never call Meta.
- [ ] **Step 2: Run `deno test supabase/functions/analyze-audience-location/index_test.ts`**. Expected: fails because handler is not implemented. If Deno is unavailable, note it explicitly.
- [ ] **Step 3: Implement request handling**: exact-origin CORS, OPTIONS response, POST-only, JSON content-type, bearer token validation via Supabase Auth `getUser(token)`, and date validation before external calls.
- [ ] **Step 4: Implement bounded Meta requests**: read only active ad sets plus parent campaign objective/name and targeting fields; fetch insights for the requested range. Follow pagination, cap at 200 ad sets, return a truncation flag, and use Meta API v24.0. Never log token, raw URL/query, or raw provider error body.
- [ ] **Step 5: Normalize targeting**: include/exclude location labels/codes as returned, age/gender, broad-interest/custom-audience presence. Omit custom audience names/IDs. Mark fields unavailable instead of inferring. `javaCoverage` is `includes`, `excludes`, `not-targeted`, or `unknown`; do not imply delivery/results there.
- [ ] **Step 6: Fetch campaign-level funnel data** using the caller's Supabase JWT and anon key, selecting only own rows in the requested date window and relevant campaign IDs; preserve exact date matching and never distribute counts to ad sets.
- [ ] **Step 7: Aggregate insights** by ad set and canonical result type. Keep zero distinct from null; calculate cost only with finite spend and positive finite results; return clear coverage/limitations. Sanitize provider/auth/database failures into safe error codes/messages.
- [ ] **Step 8: Run Deno tests** and assert no test output contains secret values. Expected: all pass with mocked fetch.
- [ ] **Step 9: Commit** with `git add supabase/functions/analyze-audience-location && git commit -m "feat: add authenticated Meta audience analyzer function"`.

## Task 3: Configure RLS and Document Deployment

**Files:**
- Modify: `supabase/README.md`
- Modify `supabase/schema.sql` only if an authenticated select grant/policy is missing; do not broaden existing `auth.uid() = user_id` isolation.

- [ ] **Step 1: Inspect the current table policy** and confirm authenticated select is available to the caller JWT while anon remains denied.
- [ ] **Step 2: Add setup documentation** for deploying the function with Supabase CLI, setting the three secrets through `supabase secrets set`, keeping JWT verification enabled, configuring exact Pages origin CORS, requiring public sign-up disabled for personal use, and adding the necessary Meta read permissions.
- [ ] **Step 3: Add a manual security verification checklist**: unauthenticated invoke returns 401; authenticated user sees only their own funnel; no service key is used; secrets do not appear in logs or response.
- [ ] **Step 4: Cross-check names and commands** against the implementation, then run `git diff --check`.
- [ ] **Step 5: Commit** with `git add supabase/README.md supabase/schema.sql && git commit -m "docs: configure secure analyzer deployment"` (omit unchanged schema from `git add`).

## Task 4: Add the User-Triggered UI

**Files:**
- Modify: `index.html`, `app.js`, `styles.css`, `tests/audience-analysis.test.js`.

**UI contract:** Button **Analisis audience & lokasi**; default range is last 28 complete days, visibly stated; no request on page load; button requires remote Supabase auth. Results stay in memory only.

- [ ] **Step 1: Add failing DOM/behavior tests** for button/date/status/results elements, signed-out click not invoking the function, and clearing stale results before a new request.
- [ ] **Step 2: Run `node --test tests/audience-analysis.test.js`**; expected: fail for missing DOM/handler behavior.
- [ ] **Step 3: Add markup** for date range, analyze button, `aria-live` progress/error region, hidden results table, campaign funnel section, and visible scope caveat.
- [ ] **Step 4: Implement click handler**: require `funnelStorageMode === 'remote'`; clear stale results; disable button; invoke `analyze-audience-location` with `{ since, until }`; normalize response; render; on error show sanitized message; always re-enable button.
- [ ] **Step 5: Render safely** using DOM elements and `textContent`; label ad-set targeting/performance separately from campaign funnel; distinguish missing metrics from zero; show Java targeting status only from returned configuration; explicitly say campaign funnel quality cannot be attributed to ad sets.
- [ ] **Step 6: Run `node --test tests/audience-analysis.test.js` and `node --test tests/*.test.js`**; expected: pass. Manually inspect desktop/mobile layout and verify there is no auto-fetch.
- [ ] **Step 7: Commit** with `git add app.js index.html styles.css tests/audience-analysis.test.js && git commit -m "feat: add manual audience and location analysis UI"`.

## Task 5: Deploy and Verify End-to-End

**Files:** no public data snapshot changes; modify docs only if setup findings require it.

- [ ] **Step 1: User applies any documented Supabase SQL and sets `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `ALLOWED_ORIGIN` directly in Supabase Secrets. Never request secrets in chat.**
- [ ] **Step 2: Deploy Edge Function** with `supabase functions deploy analyze-audience-location`; keep gateway JWT verification enabled.
- [ ] **Step 3: Test authenticated/manual flow**: signed-out attempt denied; signed-in click returns active ad sets; missing permissions return sanitized error; user-scoped funnel is shown at campaign scope only; no results or secrets are written into static files.
- [ ] **Step 4: Deploy frontend changes** by committing/pushing code and docs only. Verify Actions success and public page HTTP 200; compare `data/meta-snapshot.json` to ensure unchanged.
- [ ] **Step 5: Report** what is live, required user-side Supabase/Meta setup, actual test results, and any unavailable targeting/metric fields.
