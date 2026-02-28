#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function parseArgs(argv) {
  const out = {
    input: "",
    tenantId: "",
    tenantName: "",
    dryRun: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || "");
    if (!a) continue;

    if (a === "--commit") {
      out.dryRun = false;
      continue;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }

    if (a.startsWith("--input=")) {
      out.input = a.slice("--input=".length).trim();
      continue;
    }
    if (a === "--input") {
      out.input = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }

    if (a.startsWith("--tenant-id=")) {
      out.tenantId = a.slice("--tenant-id=".length).trim();
      continue;
    }
    if (a === "--tenant-id") {
      out.tenantId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }

    if (a.startsWith("--tenant-name=")) {
      out.tenantName = a.slice("--tenant-name=".length).trim();
      continue;
    }
    if (a === "--tenant-name") {
      out.tenantName = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
  }

  return out;
}

function readJsonFile(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw);
  return { abs, parsed };
}

function str(v) {
  return String(v ?? "").trim();
}

function low(v) {
  return str(v).toLowerCase();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v, fallback = 0) {
  return Math.trunc(num(v, fallback));
}

function normalizeCategoryLookup(categories) {
  const byId = new Map();
  const byName = new Map();
  for (const raw of categories || []) {
    if (!raw || typeof raw !== "object") continue;
    const id = low(raw.id);
    const name = str(raw.name);
    if (id) byId.set(id, name || id);
    if (name) byName.set(low(name), name);
  }
  return { byId, byName };
}

function pickCategoryName(rawCategory, lookup) {
  const c = str(rawCategory);
  if (!c) return null;
  const byIdHit = lookup.byId.get(low(c));
  if (byIdHit) return byIdHit;
  const byNameHit = lookup.byName.get(low(c));
  if (byNameHit) return byNameHit;
  return c;
}

function normalizeProductType(raw) {
  const t = low(raw);
  if (t === "service") return "service";
  if (t === "physical") return "physical";
  if (t === "good" || t === "product" || t === "item") return "good";
  return "good";
}

function normalizeProducts(masterProducts, categoryLookup, validationFailures) {
  const out = [];
  (masterProducts || []).forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      validationFailures.push(`products[${idx}] is not an object`);
      return;
    }

    const name = str(raw.name || raw.product_name || raw.productName);
    if (!name) {
      validationFailures.push(`products[${idx}] missing name`);
      return;
    }

    const price = num(raw.price ?? raw.selling_price ?? raw.sellingPrice ?? 0, 0);
    const costPrice = num(raw.cost_price ?? raw.cost ?? raw.costPrice ?? raw.buying_price ?? 0, 0);
    const stockQty = int(raw.stock_quantity ?? raw.stock ?? raw.quantity ?? 0, 0);
    const lowStockThreshold = int(raw.low_stock_threshold ?? raw.lowStockThreshold ?? raw.reorder_level ?? 5, 5);
    const type = normalizeProductType(raw.type);

    out.push({
      source_idx: idx,
      name,
      category: pickCategoryName(raw.category, categoryLookup),
      type,
      sku: str(raw.sku || raw.item_code || raw.itemCode) || null,
      barcode: str(raw.barcode || raw.bar_code) || null,
      shortcut_code: str(raw.shortcut_code || raw.shortcutCode) || null,
      price,
      cost_price: costPrice,
      stock_quantity: Math.max(0, stockQty),
      low_stock_threshold: Math.max(0, lowStockThreshold),
      is_variable_price: raw.is_variable_price === true || raw.isVariablePrice === true,
      requires_note: raw.requires_note === true || raw.requiresNote === true,
    });
  });
  return out;
}

function normalizeOpeningRows(openingRows, validationFailures) {
  const out = [];
  (openingRows || []).forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      validationFailures.push(`opening.stock[${idx}] is not an object`);
      return;
    }

    const qty = int(raw.quantity ?? raw.qty ?? raw.opening_qty ?? raw.openingQuantity ?? 0, 0);
    const sku = str(raw.sku || raw.item_code || raw.itemCode);
    const barcode = str(raw.barcode || raw.bar_code);
    const name = str(raw.name || raw.product_name || raw.productName);
    const cost = raw.cost_price ?? raw.unit_cost ?? raw.cost ?? null;
    const price = raw.price ?? raw.selling_price ?? raw.sellingPrice ?? null;

    if (!sku && !barcode && !name) {
      validationFailures.push(`opening.stock[${idx}] missing identifier (sku/barcode/name)`);
      return;
    }

    out.push({
      source_idx: idx,
      sku: sku || null,
      barcode: barcode || null,
      name: name || null,
      quantity: Math.max(0, qty),
      cost_price: cost == null ? null : Math.max(0, num(cost, 0)),
      price: price == null ? null : Math.max(0, num(price, 0)),
    });
  });
  return out;
}

function normalizeDataset(payload) {
  const master = payload?.master && typeof payload.master === "object" ? payload.master : payload;
  const opening = payload?.opening && typeof payload.opening === "object" ? payload.opening : payload;

  const categories = Array.isArray(master?.categories) ? master.categories : Array.isArray(payload?.categories) ? payload.categories : [];
  const products = Array.isArray(master?.products) ? master.products : Array.isArray(payload?.products) ? payload.products : [];
  const customers = Array.isArray(master?.customers) ? master.customers : Array.isArray(payload?.customers) ? payload.customers : [];
  const suppliers = Array.isArray(master?.suppliers) ? master.suppliers : Array.isArray(payload?.suppliers) ? payload.suppliers : [];
  const openingStock = Array.isArray(opening?.stock)
    ? opening.stock
    : Array.isArray(payload?.opening_stock)
      ? payload.opening_stock
      : Array.isArray(payload?.openingStock)
        ? payload.openingStock
        : [];
  const openingBalances = Array.isArray(opening?.balances)
    ? opening.balances
    : Array.isArray(payload?.opening_balances)
      ? payload.opening_balances
      : Array.isArray(payload?.openingBalances)
        ? payload.openingBalances
        : [];

  return {
    categories,
    products,
    customers,
    suppliers,
    openingStock,
    openingBalances,
  };
}

function mapProductsByIdentity(rows) {
  const byId = new Map();
  const bySku = new Map();
  const byBarcode = new Map();
  const byName = new Map();

  for (const row of rows || []) {
    const id = str(row.id);
    if (!id) continue;
    byId.set(id, row);
    const sku = low(row.sku);
    if (sku && !bySku.has(sku)) bySku.set(sku, row);
    const barcode = low(row.barcode);
    if (barcode && !byBarcode.has(barcode)) byBarcode.set(barcode, row);
    const name = low(row.name);
    if (name && !byName.has(name)) byName.set(name, row);
  }

  return { byId, bySku, byBarcode, byName };
}

function findProductMatch(row, productIndex) {
  const sku = low(row.sku);
  if (sku && productIndex.bySku.has(sku)) return productIndex.bySku.get(sku);

  const barcode = low(row.barcode);
  if (barcode && productIndex.byBarcode.has(barcode)) return productIndex.byBarcode.get(barcode);

  const name = low(row.name);
  if (name && productIndex.byName.has(name)) return productIndex.byName.get(name);

  return null;
}

async function resolveTenant(admin, opts) {
  if (opts.tenantId) {
    const { data, error } = await admin
      .from("businesses")
      .select("id, name, status, created_at")
      .eq("id", opts.tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Tenant not found by id: ${opts.tenantId}`);
    return data;
  }

  if (!opts.tenantName) {
    throw new Error("Provide --tenant-id or --tenant-name");
  }

  const { data, error } = await admin
    .from("businesses")
    .select("id, name, status, created_at")
    .ilike("name", opts.tenantName)
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw error;

  const rows = data || [];
  if (rows.length === 0) throw new Error(`Tenant not found by name: ${opts.tenantName}`);
  if (rows.length > 1) {
    throw new Error(
      `Tenant name "${opts.tenantName}" matched multiple rows. Use --tenant-id. Matches: ${rows
        .map((r) => `${r.id}:${r.name}`)
        .join(", ")}`
    );
  }
  return rows[0];
}

async function tableExists(admin, tableName) {
  const { error } = await admin.from(tableName).select("id").limit(1);
  if (!error) return true;
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  if (code === "42P01" || msg.includes("does not exist")) return false;
  return true;
}

function normalizePartyRows(rows, validationFailures, label) {
  const out = [];
  (rows || []).forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      validationFailures.push(`${label}[${idx}] is not an object`);
      return;
    }
    const name = str(raw.name || raw.full_name || raw.company_name || raw.companyName);
    if (!name) {
      validationFailures.push(`${label}[${idx}] missing name`);
      return;
    }
    out.push({
      source_idx: idx,
      name,
      phone: str(raw.phone || raw.mobile || raw.contact) || null,
      email: str(raw.email) || null,
      address: str(raw.address) || null,
    });
  });
  return out;
}

async function importParties({
  admin,
  tableName,
  businessId,
  rows,
  dryRun,
  warnings,
  report,
}) {
  if (!rows.length) {
    report.skipped += 1;
    return;
  }

  const exists = await tableExists(admin, tableName);
  if (!exists) {
    warnings.push(`${tableName} table not found, skipped ${rows.length} row(s).`);
    report.skipped += rows.length;
    return;
  }

  if (dryRun) {
    report.planned += rows.length;
    return;
  }

  for (const row of rows) {
    const payload = {
      business_id: businessId,
      name: row.name,
      phone: row.phone,
      email: row.email,
      address: row.address,
    };

    const { error } = await admin.from(tableName).insert(payload);
    if (error) {
      warnings.push(`${tableName} insert warning: ${error.message}`);
      report.failed += 1;
    } else {
      report.imported += 1;
    }
  }
}

async function runImport() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    throw new Error("Usage: node scripts/import_tenant_master_opening.mjs --input <file> [--tenant-id <uuid>|--tenant-name <name>] [--dry-run|--commit]");
  }

  const url = process.env.SUPABASE_URL || process.env.PROJECT_URL || mustEnv("VITE_SUPABASE_URL");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { abs, parsed } = readJsonFile(args.input);
  const dataset = normalizeDataset(parsed);
  const validationFailures = [];
  const warnings = [];

  const tenant = await resolveTenant(admin, {
    tenantId: args.tenantId || str(parsed?.tenant?.id),
    tenantName: args.tenantName || str(parsed?.tenant?.name || parsed?.business_name || parsed?.businessName),
  });
  const businessId = str(tenant.id);

  const categoryLookup = normalizeCategoryLookup(dataset.categories);
  const normalizedProducts = normalizeProducts(dataset.products, categoryLookup, validationFailures);
  const normalizedOpening = normalizeOpeningRows(dataset.openingStock, validationFailures);
  const normalizedCustomers = normalizePartyRows(dataset.customers, validationFailures, "customers");
  const normalizedSuppliers = normalizePartyRows(dataset.suppliers, validationFailures, "suppliers");

  const { data: existingProducts, error: existingErr } = await admin
    .from("products")
    .select("id, business_id, name, category, type, sku, barcode, shortcut_code, price, cost_price, stock_quantity, low_stock_threshold, is_variable_price, requires_note")
    .eq("business_id", businessId);
  if (existingErr) throw existingErr;

  const productRows = [...(existingProducts || [])];
  const productIndex = mapProductsByIdentity(productRows);

  const reconciliation = {
    ok: true,
    mode: args.dryRun ? "dry-run" : "commit",
    input_file: abs,
    tenant: {
      id: businessId,
      name: str(tenant.name),
      status: str(tenant.status),
    },
    counts: {
      master: {
        categories: dataset.categories.length,
        products: dataset.products.length,
        customers: dataset.customers.length,
        suppliers: dataset.suppliers.length,
      },
      opening: {
        stock_rows: dataset.openingStock.length,
        balances_rows: dataset.openingBalances.length,
      },
      imported: {
        products_created: 0,
        products_updated: 0,
        opening_stock_applied: 0,
        customers_imported: 0,
        suppliers_imported: 0,
      },
      planned_only: {
        customers: 0,
        suppliers: 0,
      },
      skipped: {
        customers: 0,
        suppliers: 0,
        opening_balances: dataset.openingBalances.length,
      },
      failed_rows: 0,
    },
    stock_delta: {
      before_total_qty: (existingProducts || []).reduce((sum, p) => sum + int(p.stock_quantity, 0), 0),
      after_total_qty: (existingProducts || []).reduce((sum, p) => sum + int(p.stock_quantity, 0), 0),
      delta_qty: 0,
    },
    warnings,
    validation_failures: validationFailures,
  };

  for (const row of normalizedProducts) {
    const match = findProductMatch(row, productIndex);
    if (match) {
      if (!args.dryRun) {
        const { error } = await admin
          .from("products")
          .update({
            name: row.name,
            category: row.category,
            type: row.type,
            sku: row.sku,
            barcode: row.barcode,
            shortcut_code: row.shortcut_code,
            price: row.price,
            cost_price: row.cost_price,
            stock_quantity: row.stock_quantity,
            low_stock_threshold: row.low_stock_threshold,
            is_variable_price: row.is_variable_price,
            requires_note: row.requires_note,
          })
          .eq("id", match.id)
          .eq("business_id", businessId);

        if (error) {
          reconciliation.counts.failed_rows += 1;
          validationFailures.push(`products[${row.source_idx}] update failed: ${error.message}`);
          continue;
        }
      }

      Object.assign(match, {
        ...match,
        ...row,
        business_id: businessId,
      });
      reconciliation.counts.imported.products_updated += 1;
    } else {
      let inserted = null;
      if (!args.dryRun) {
        const { data, error } = await admin
          .from("products")
          .insert({
            business_id: businessId,
            name: row.name,
            category: row.category,
            type: row.type,
            sku: row.sku,
            barcode: row.barcode,
            shortcut_code: row.shortcut_code,
            price: row.price,
            cost_price: row.cost_price,
            stock_quantity: row.stock_quantity,
            low_stock_threshold: row.low_stock_threshold,
            is_variable_price: row.is_variable_price,
            requires_note: row.requires_note,
            is_archived: false,
          })
          .select("id, business_id, name, category, type, sku, barcode, shortcut_code, price, cost_price, stock_quantity, low_stock_threshold, is_variable_price, requires_note")
          .single();

        if (error) {
          reconciliation.counts.failed_rows += 1;
          validationFailures.push(`products[${row.source_idx}] insert failed: ${error.message}`);
          continue;
        }
        inserted = data;
      } else {
        inserted = {
          id: `planned-${row.source_idx}`,
          business_id: businessId,
          ...row,
        };
      }

      productRows.push(inserted);
      const idx = mapProductsByIdentity(productRows);
      productIndex.byId.clear();
      productIndex.bySku.clear();
      productIndex.byBarcode.clear();
      productIndex.byName.clear();
      idx.byId.forEach((v, k) => productIndex.byId.set(k, v));
      idx.bySku.forEach((v, k) => productIndex.bySku.set(k, v));
      idx.byBarcode.forEach((v, k) => productIndex.byBarcode.set(k, v));
      idx.byName.forEach((v, k) => productIndex.byName.set(k, v));

      reconciliation.counts.imported.products_created += 1;
    }
  }

  for (const row of normalizedOpening) {
    const match =
      (row.sku && productIndex.bySku.get(low(row.sku))) ||
      (row.barcode && productIndex.byBarcode.get(low(row.barcode))) ||
      (row.name && productIndex.byName.get(low(row.name))) ||
      null;

    if (!match) {
      reconciliation.counts.failed_rows += 1;
      validationFailures.push(
        `opening.stock[${row.source_idx}] product not found for identifiers sku=${row.sku || "-"} barcode=${row.barcode || "-"} name=${row.name || "-"}`
      );
      continue;
    }

    const beforeQty = int(match.stock_quantity, 0);
    const afterQty = Math.max(0, int(row.quantity, 0));
    const nextCost = row.cost_price == null ? match.cost_price : row.cost_price;
    const nextPrice = row.price == null ? match.price : row.price;

    if (!args.dryRun) {
      const { error } = await admin
        .from("products")
        .update({
          stock_quantity: afterQty,
          cost_price: nextCost,
          price: nextPrice,
        })
        .eq("id", match.id)
        .eq("business_id", businessId);
      if (error) {
        reconciliation.counts.failed_rows += 1;
        validationFailures.push(`opening.stock[${row.source_idx}] update failed: ${error.message}`);
        continue;
      }
    }

    match.stock_quantity = afterQty;
    match.cost_price = nextCost;
    match.price = nextPrice;
    reconciliation.counts.imported.opening_stock_applied += 1;
    reconciliation.stock_delta.delta_qty += afterQty - beforeQty;
  }

  const customerReport = { imported: 0, failed: 0, planned: 0, skipped: 0 };
  await importParties({
    admin,
    tableName: "customers",
    businessId,
    rows: normalizedCustomers,
    dryRun: args.dryRun,
    warnings,
    report: customerReport,
  });
  reconciliation.counts.imported.customers_imported = customerReport.imported;
  reconciliation.counts.planned_only.customers = customerReport.planned;
  reconciliation.counts.skipped.customers = customerReport.skipped;
  reconciliation.counts.failed_rows += customerReport.failed;

  const supplierReport = { imported: 0, failed: 0, planned: 0, skipped: 0 };
  await importParties({
    admin,
    tableName: "suppliers",
    businessId,
    rows: normalizedSuppliers,
    dryRun: args.dryRun,
    warnings,
    report: supplierReport,
  });
  reconciliation.counts.imported.suppliers_imported = supplierReport.imported;
  reconciliation.counts.planned_only.suppliers = supplierReport.planned;
  reconciliation.counts.skipped.suppliers = supplierReport.skipped;
  reconciliation.counts.failed_rows += supplierReport.failed;

  const finalQty = productRows.reduce((sum, p) => sum + int(p.stock_quantity, 0), 0);
  reconciliation.stock_delta.after_total_qty = finalQty;
  reconciliation.stock_delta.delta_qty = finalQty - reconciliation.stock_delta.before_total_qty;

  if (dataset.openingBalances.length > 0) {
    warnings.push(
      `opening balances provided (${dataset.openingBalances.length}) but no opening balance table contract exists in this schema. Rows skipped.`
    );
  }

  if (validationFailures.length > 0) {
    reconciliation.ok = false;
  }

  console.log(JSON.stringify(reconciliation, null, 2));
  if (!reconciliation.ok) process.exitCode = 2;
}

runImport().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});
