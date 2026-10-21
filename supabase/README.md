# Supabase private funnel setup

The dashboard is a public static GitHub Pages site. Funnel records are remote only after a user saves project configuration, signs in, and the RLS schema below is installed. The default remains browser-local storage.

## 1. Create a private project and restrict access

1. Create a Supabase project in an account you control.
2. In **Authentication → Providers → Email**, turn off public sign-ups if this dashboard should be for you only. Create your own user manually under **Authentication → Users**. If using multiple team members, create only approved accounts manually.
3. Keep email confirmation enabled. Configure the project's Site URL and Redirect URLs to `https://pippoauliaa-dev.github.io` (and the exact dashboard URL if requested by the Supabase UI).
4. Do not enable anonymous sign-in.

The project URL and publishable/anon key are public browser credentials, not secrets. RLS and disabled public sign-up are the access controls. Never put a `service_role` key in this repository, in the dashboard, or in a browser.

## 2. Create the private table and policies

Open Supabase **SQL Editor**, run [`schema.sql`](schema.sql), and verify it succeeds. The table has RLS enabled, reads restricted to `auth.uid()`, inserts/deletes only for the current user, and writes go through an authenticated `SECURITY INVOKER` RPC that replaces only the caller's own rows.

## 3. Configure the dashboard

Open the dashboard over HTTPS, choose **Hubungkan penyimpanan privat**, and enter:

- Project URL from Supabase Project Settings → API
- Publishable key (or legacy anon key) from the same page — never service_role
- An approved user's email and password

Save the config, then choose **Masuk**. The browser stores the URL, publishable key, and that user's refreshable auth session in that browser's local storage. Funnel data itself is read/written to the RLS-protected Supabase table. Sign out to return to that browser's local funnel data.

## 4. Move existing local records

Before enabling cloud storage, export the local funnel backup using **Ekspor backup JSON**. After signing in, use **Impor backup** and confirm merge; the imported records are saved to the signed-in user's private table. Verify counts and dates before deleting any old local backup. Existing backups without `dealsClosed` remain valid; the field defaults to null.

## Data handling

Only aggregate campaign/date funnel counts and the optional outcome note are sent to Supabase. Do not enter company names, contact details, lead identifiers, or other personal data in notes. Each user sees only their own rows through RLS. The public Meta campaign/content snapshot on GitHub Pages remains public and is unrelated to this private funnel storage.
