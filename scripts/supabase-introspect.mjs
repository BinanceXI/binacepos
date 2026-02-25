#!/usr/bin/env node

import fs from "fs";
import path from "path";

const DEFAULT_REFS = {
  masters: "cdxazhylmefeevytokpk",
  binancexi: "bqlejluaicankgomrizi",
};

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === "--out-dir" && b) {
      out.outDir = b;
      i += 1;
      continue;
    }
    if (a === "--masters-ref" && b) {
      out.mastersRef = b;
      i += 1;
      continue;
    }
    if (a === "--binance-ref" && b) {
      out.binanceRef = b;
      i += 1;
      continue;
    }
  }
  return out;
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
    throw new Error(`Non-JSON response for ${projectRef} (${res.status})`);
  }
  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : JSON.stringify(data);
    throw new Error(`Supabase query failed for ${projectRef} (${res.status}): ${msg}`);
  }
  return data;
}

function rowsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

const QUERIES = {
  columns: `
    select table_schema, table_name, column_name, data_type, udt_name, is_nullable,
           column_default, ordinal_position
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position;
  `,
  constraints: `
    select
      n.nspname as table_schema,
      c.relname as table_name,
      con.conname as constraint_name,
      con.contype as constraint_type,
      pg_get_constraintdef(con.oid, true) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    order by c.relname, con.conname;
  `,
  indexes: `
    select schemaname, tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname;
  `,
  rls: `
    select
      n.nspname as schema_name,
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname;
  `,
  policies: `
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
    order by tablename, policyname;
  `,
  routines: `
    select
      n.nspname as schema_name,
      p.proname as function_name,
      p.oid::regprocedure::text as signature,
      pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public')
    order by 1,2,3;
  `,
  triggers: `
    select
      n.nspname as schema_name,
      c.relname as table_name,
      t.tgname as trigger_name,
      pg_get_triggerdef(t.oid, true) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by c.relname, t.tgname;
  `,
  extensions: `
    select extname, extversion
    from pg_extension
    order by extname;
  `,
};

async function collectProjectSnapshot(label, ref, token) {
  const sections = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    const payload = await queryDb(ref, token, sql);
    sections[name] = rowsFromResponse(payload);
  }
  return {
    label,
    ref,
    collected_at: new Date().toISOString(),
    sections,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const mastersToken = String(process.env.MASTERS_SUPABASE_TOKEN || "").trim();
  const binanceToken = String(process.env.BINANCEXI_SUPABASE_TOKEN || "").trim();

  if (!mastersToken || !binanceToken) {
    console.error("Missing MASTERS_SUPABASE_TOKEN or BINANCEXI_SUPABASE_TOKEN.");
    process.exit(1);
  }

  const outDir =
    args.outDir || path.join("/tmp", "binancexi-parity-audit", ts(), "introspection");
  fs.mkdirSync(outDir, { recursive: true });

  const mastersRef = args.mastersRef || DEFAULT_REFS.masters;
  const binanceRef = args.binanceRef || DEFAULT_REFS.binancexi;

  const masters = await collectProjectSnapshot("masters", mastersRef, mastersToken);
  const binance = await collectProjectSnapshot("binancexi", binanceRef, binanceToken);

  fs.writeFileSync(path.join(outDir, "masters.json"), JSON.stringify(masters, null, 2));
  fs.writeFileSync(path.join(outDir, "binancexi.json"), JSON.stringify(binance, null, 2));

  const meta = {
    created_at: new Date().toISOString(),
    out_dir: outDir,
    refs: { masters: mastersRef, binancexi: binanceRef },
    sections: Object.keys(QUERIES),
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(`[supabase-introspect] Wrote snapshots to ${outDir}`);
  console.log(`[supabase-introspect] refs: masters=${mastersRef}, binancexi=${binanceRef}`);
}

main().catch((e) => {
  console.error(`[supabase-introspect] ${e?.message || e}`);
  process.exit(1);
});

