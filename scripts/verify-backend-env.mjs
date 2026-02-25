#!/usr/bin/env node

import fs from "fs";
import path from "path";

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!key) continue;
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

function readEnvFiles(mode) {
  const cwd = process.cwd();
  const files = [
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
    path.join(cwd, `.env.${mode}`),
    path.join(cwd, `.env.${mode}.local`),
  ];

  const merged = {};
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf-8");
    Object.assign(merged, parseEnvFile(txt));
  }
  return merged;
}

function supabaseRefFromUrl(url) {
  const u = new URL(url);
  const host = u.hostname || "";
  const ref = host.split(".")[0] || "";
  return ref || null;
}

const mode = process.env.MODE || process.env.NODE_ENV || "production";
const dotEnv = readEnvFiles(mode);

const url = process.env.VITE_SUPABASE_URL || dotEnv.VITE_SUPABASE_URL || "";
const anon = process.env.VITE_SUPABASE_ANON_KEY || dotEnv.VITE_SUPABASE_ANON_KEY || "";

const defaultExpected = "bqlejluaicankgomrizi";
const expectedRef = (
  process.env.VITE_EXPECTED_SUPABASE_REF ||
  dotEnv.VITE_EXPECTED_SUPABASE_REF ||
  defaultExpected
).trim();

const allowed = (
  process.env.VITE_ALLOWED_SUPABASE_REFS ||
  dotEnv.VITE_ALLOWED_SUPABASE_REFS ||
  expectedRef
).trim();
const allowedRefs = allowed.split(",").map((s) => s.trim()).filter(Boolean);

if (!url) {
  console.error(
    "[backend-check] Missing VITE_SUPABASE_URL. Set it in your build environment or .env/.env.local."
  );
  process.exit(1);
}
if (!anon) {
  console.error(
    "[backend-check] Missing VITE_SUPABASE_ANON_KEY. Set it in your build environment or .env/.env.local."
  );
  process.exit(1);
}

let actualRef = null;
try {
  actualRef = supabaseRefFromUrl(url);
} catch {
  console.error(`[backend-check] Invalid VITE_SUPABASE_URL: ${url}`);
  process.exit(1);
}

if (!actualRef) {
  console.error(`[backend-check] Unable to parse Supabase project ref from VITE_SUPABASE_URL: ${url}`);
  process.exit(1);
}

if (!allowedRefs.includes(actualRef)) {
  console.error(
    `[backend-check] Wrong Supabase backend configured. Got ref "${actualRef}" but expected: ${allowedRefs.join(", ")}.`
  );
  console.error(
    "[backend-check] Fix VITE_SUPABASE_URL in your build environment (CI, shell env, or .env/.env.local)."
  );
  process.exit(1);
}

console.log(`[backend-check] OK: Supabase ref "${actualRef}" (mode=${mode})`);

