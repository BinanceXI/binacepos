#!/usr/bin/env node

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const FAILURES = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function has(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function assert(cond, msg) {
  if (!cond) FAILURES.push(msg);
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadDotEnv() {
  const merged = {};
  for (const file of [".env", ".env.local"]) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    Object.assign(merged, parseEnvFile(fs.readFileSync(abs, "utf8")));
  }
  return merged;
}

function getProjectRefFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

async function queryDb(projectRef, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : JSON.stringify(data);
    throw new Error(`Query failed (${res.status}): ${msg}`);
  }
  return data;
}

function rowsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function runStaticChecks() {
  const reports = read("src/pages/ReportsPage.tsx");
  assert(
    /from ['"]@\/lib\/tenantScope['"]/.test(reports) &&
      /resolveTenantScope/.test(reports) &&
      /tenantScopeKey/.test(reports) &&
      /writeScopedJSON/.test(reports),
    "ReportsPage is missing tenantScope imports/usage expected for scoped caching."
  );

  const expenses = read("src/lib/expenses.ts");
  assert(/business_id/.test(expenses), "expenses.ts missing business_id handling.");
  assert(/tenantScopeKey/.test(expenses), "expenses.ts missing tenant scope key usage.");
  assert(/onConflict:\s*["']id["']/.test(expenses), "expenses.ts missing idempotent upsert on id.");

  const bookings = read("src/lib/serviceBookings.ts");
  assert(/business_id/.test(bookings), "serviceBookings.ts missing business_id handling.");
  assert(/tenantScopeKey/.test(bookings), "serviceBookings.ts missing tenant scope key usage.");
  assert(
    /onConflict:\s*["']id["']/.test(bookings),
    "serviceBookings.ts missing idempotent upsert on id."
  );

  const inventory = read("src/lib/inventorySync.ts");
  assert(
    /getTenantScopeFromLocalUser/.test(inventory) &&
      /readScopedJSON/.test(inventory) &&
      /writeScopedJSON/.test(inventory),
    "inventorySync.ts is missing tenant-scoped queue storage."
  );

  for (const fn of [
    "supabase/functions/create_staff_user/index.ts",
    "supabase/functions/delete_staff_user/index.ts",
    "supabase/functions/set_staff_password/index.ts",
  ]) {
    const text = read(fn);
    assert(
      /\.select\("role,\s*active,\s*business_id"\)/.test(text),
      `${fn} is missing caller business_id role check projection.`
    );
  }

  const uploadFn = read("supabase/functions/upload_product_image/index.ts");
  assert(
    /\.select\("role,\s*active,\s*permissions,\s*business_id"\)/.test(uploadFn),
    "upload_product_image is missing business_id in permission profile projection."
  );
}

async function runLiveChecksIfAvailable() {
  const token = String(process.env.BINANCEXI_SUPABASE_TOKEN || "").trim();
  if (!token) {
    console.log("[tenant-scope] Live policy check skipped (BINANCEXI_SUPABASE_TOKEN not set).");
    return;
  }

  const dotEnv = loadDotEnv();
  const url = process.env.VITE_SUPABASE_URL || dotEnv.VITE_SUPABASE_URL || "";
  const ref = getProjectRefFromUrl(url);
  if (!ref) {
    throw new Error("Cannot derive BinanceXI Supabase ref from VITE_SUPABASE_URL for live policy check.");
  }

  const sql = `
    with target_tables as (
      select unnest(array[
        'orders','order_items','products','expenses','service_bookings','profiles','store_settings','app_feedback'
      ]) as table_name
    )
    select
      t.table_name,
      exists (
        select 1 from information_schema.tables it
        where it.table_schema = 'public' and it.table_name = t.table_name
      ) as table_exists,
      exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'business_id'
      ) as has_business_id,
      coalesce(c.relrowsecurity, false) as rls_enabled,
      coalesce(c.relforcerowsecurity, false) as rls_forced,
      coalesce((
        select json_agg(json_build_object(
          'policyname', p.policyname,
          'cmd', p.cmd,
          'qual', p.qual,
          'with_check', p.with_check
        ) order by p.policyname)
        from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.table_name
      ), '[]'::json) as policies
    from target_tables t
    left join pg_class c on c.relname = t.table_name
    left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    order by t.table_name;
  `;

  const payload = await queryDb(ref, token, sql);
  const rows = rowsFromResponse(payload);

  for (const row of rows) {
    const tableName = String(row.table_name || "");
    const exists = row.table_exists === true;
    if (!exists) continue;
    assert(row.rls_enabled === true, `RLS disabled on public.${tableName}.`);
    const policies = Array.isArray(row.policies) ? row.policies : [];
    assert(policies.length > 0, `No RLS policies found for public.${tableName}.`);

    if (row.has_business_id === true) {
      const combined = JSON.stringify(policies).toLowerCase();
      const hasTenantGuardSignal =
        combined.includes("business_id") ||
        combined.includes("current_business_id") ||
        combined.includes("can_manage_business") ||
        combined.includes("is_business_in_good_standing") ||
        combined.includes("can_manage_inventory()");
      assert(
        hasTenantGuardSignal,
        `Policies for public.${tableName} do not appear to reference tenant guard predicates/functions.`
      );
    }
  }

  console.log(`[tenant-scope] Live policy check passed for ref "${ref}".`);
}

async function main() {
  const requiredFiles = [
    "src/pages/ReportsPage.tsx",
    "src/lib/expenses.ts",
    "src/lib/inventorySync.ts",
    "src/lib/serviceBookings.ts",
    "supabase/functions/create_staff_user/index.ts",
    "supabase/functions/delete_staff_user/index.ts",
    "supabase/functions/set_staff_password/index.ts",
    "supabase/functions/upload_product_image/index.ts",
  ];
  for (const f of requiredFiles) assert(has(f), `Missing required file: ${f}`);

  runStaticChecks();
  await runLiveChecksIfAvailable().catch((e) => {
    FAILURES.push(String(e?.message || e));
  });

  if (FAILURES.length) {
    console.error("[tenant-scope] Verification failed:");
    for (const f of FAILURES) console.error(`- ${f}`);
    process.exit(1);
  }

  console.log("[tenant-scope] OK (static checks passed).");
}

main().catch((e) => {
  console.error(`[tenant-scope] Unhandled error: ${e?.message || e}`);
  process.exit(1);
});
