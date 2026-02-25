#!/usr/bin/env node

import fs from "fs";
import path from "path";

const CRITICAL_TABLES = [
  "orders",
  "order_items",
  "products",
  "expenses",
  "service_bookings",
  "profiles",
  "store_settings",
  "app_feedback",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const b = argv[i + 1];
    if (a === "--dir" && b) {
      out.dir = b;
      i += 1;
      continue;
    }
  }
  return out;
}

function latestAuditDir() {
  const base = "/tmp/binancexi-parity-audit";
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base)
    .map((name) => path.join(base, name, "introspection"))
    .filter((p) => fs.existsSync(path.join(p, "masters.json")) && fs.existsSync(path.join(p, "binancexi.json")))
    .sort();
  return dirs[dirs.length - 1] || null;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function normalizeSql(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .trim();
}

function keyBy(rows, keyFn) {
  const m = new Map();
  for (const row of rows || []) m.set(keyFn(row), row);
  return m;
}

function rowsForTable(rows, tableKey = "table_name", table) {
  return (rows || []).filter((r) => String(r?.[tableKey] || r?.tablename || "").trim() === table);
}

function collectTableSummary(snapshot, table) {
  const sections = snapshot.sections || {};
  const columns = rowsForTable(sections.columns, "table_name", table);
  const constraints = rowsForTable(sections.constraints, "table_name", table);
  const indexes = rowsForTable(sections.indexes, "tablename", table);
  const rls = rowsForTable(sections.rls, "table_name", table)[0] || null;
  const policies = rowsForTable(sections.policies, "tablename", table);
  return { columns, constraints, indexes, rls, policies };
}

function compareTable(masters, binance, table) {
  const deltas = [];
  const m = collectTableSummary(masters, table);
  const b = collectTableSummary(binance, table);

  if (!m.columns.length) return deltas; // table not in Masters scope, skip

  if (!b.columns.length) {
    deltas.push({ type: "missing_table", table, severity: "high" });
    return deltas;
  }

  if (m.rls?.rls_enabled === true && b.rls?.rls_enabled !== true) {
    deltas.push({ type: "missing_rls", table, severity: "high" });
  }

  if ((m.policies || []).length > (b.policies || []).length) {
    deltas.push({
      type: "fewer_policies",
      table,
      severity: "medium",
      masters_count: m.policies.length,
      binance_count: b.policies.length,
    });
  }

  const mastersHasBiz = m.columns.some((c) => String(c.column_name) === "business_id");
  if (mastersHasBiz && b.policies.length) {
    const combined = normalizeSql(JSON.stringify(b.policies));
    if (!combined.includes("business_id")) {
      deltas.push({ type: "policies_missing_business_id_reference", table, severity: "high" });
    }
  }

  const bConstraintDefs = new Set(b.constraints.map((c) => normalizeSql(c.definition)));
  for (const c of m.constraints) {
    const def = normalizeSql(c.definition);
    if (!bConstraintDefs.has(def)) {
      deltas.push({
        type: "missing_constraint",
        table,
        severity: c.constraint_type === "f" || c.constraint_type === "u" ? "medium" : "low",
        constraint_name: c.constraint_name,
        definition: c.definition,
      });
    }
  }

  const scrubIndex = (indexdef) =>
    normalizeSql(indexdef)
      .replace(/^create (unique )?index [^ ]+ on /, "create index on ")
      .trim();
  const bIndexDefs = new Set(b.indexes.map((i) => scrubIndex(i.indexdef)));
  for (const idx of m.indexes) {
    const def = scrubIndex(idx.indexdef);
    if (!bIndexDefs.has(def)) {
      deltas.push({
        type: "missing_index",
        table,
        severity: "low",
        index_name: idx.indexname,
        indexdef: idx.indexdef,
      });
    }
  }

  return deltas;
}

function markdownReport({ masters, binance, deltas }) {
  const lines = [];
  lines.push("# Supabase Security Parity Report");
  lines.push("");
  lines.push(`- Masters ref: \`${masters.ref}\``);
  lines.push(`- BinanceXI ref: \`${binance.ref}\``);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push("");
  if (!deltas.length) {
    lines.push("No security/integrity deltas detected for the audited critical tables.");
    return lines.join("\n");
  }
  for (const t of CRITICAL_TABLES) {
    const tableDeltas = deltas.filter((d) => d.table === t);
    if (!tableDeltas.length) continue;
    lines.push(`## public.${t}`);
    for (const d of tableDeltas) {
      if (d.type === "fewer_policies") {
        lines.push(
          `- [${d.severity}] Fewer policies in BinanceXI (${d.binance_count}) than Masters (${d.masters_count}).`
        );
      } else if (d.type === "missing_constraint") {
        lines.push(`- [${d.severity}] Missing constraint: \`${d.definition}\``);
      } else if (d.type === "missing_index") {
        lines.push(`- [${d.severity}] Missing index pattern: \`${d.indexdef}\``);
      } else {
        lines.push(`- [${d.severity}] ${d.type}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const dir = args.dir || latestAuditDir();
  if (!dir) {
    console.error("No introspection snapshot directory found. Run `node scripts/supabase-introspect.mjs` first.");
    process.exit(1);
  }

  const masters = loadJson(path.join(dir, "masters.json"));
  const binance = loadJson(path.join(dir, "binancexi.json"));

  const deltas = [];
  for (const table of CRITICAL_TABLES) {
    deltas.push(...compareTable(masters, binance, table));
  }

  const report = {
    generated_at: new Date().toISOString(),
    snapshot_dir: dir,
    refs: { masters: masters.ref, binancexi: binance.ref },
    critical_tables: CRITICAL_TABLES,
    deltas,
  };
  const reportPath = path.join(dir, "security-parity-report.json");
  const mdPath = path.join(dir, "security-parity-report.md");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport({ masters, binance, deltas }));

  console.log(`[supabase-compare-security] Wrote ${reportPath}`);
  console.log(`[supabase-compare-security] Wrote ${mdPath}`);
  if (!deltas.length) {
    console.log("[supabase-compare-security] No critical-table deltas detected.");
    return;
  }
  console.log(`[supabase-compare-security] Deltas detected: ${deltas.length}`);
}

main();

