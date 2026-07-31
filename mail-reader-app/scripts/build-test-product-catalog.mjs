import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const databasePath = path.join(appDirectory, "data", "order-recognition.db");
const backupDirectory = path.join(appDirectory, "data", "backups");
const applyChanges = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (applyChanges === dryRun) {
  console.error("Usage: node scripts/build-test-product-catalog.mjs --dry-run|--apply");
  process.exitCode = 1;
} else if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exitCode = 1;
} else {
  buildCatalog();
}

function buildCatalog() {
  const database = new DatabaseSync(databasePath, { readOnly: dryRun });
  let backupPath = "";

  try {
    const products = deriveProducts(database);
    printPreview(products);

    if (dryRun) {
      console.log(`Dry run complete: ${products.length} product(s) would be written.`);
      return;
    }

    fs.mkdirSync(backupDirectory, { recursive: true });
    backupPath = path.join(
      backupDirectory,
      `order-recognition-before-test-product-catalog-${timestamp()}.db`
    );
    database.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);

    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS test_product_catalog (
          id INTEGER PRIMARY KEY,
          product_code TEXT NOT NULL,
          normalized_code TEXT NOT NULL UNIQUE,
          product_name TEXT NOT NULL DEFAULT '',
          spec TEXT NOT NULL DEFAULT '',
          unit TEXT NOT NULL DEFAULT '',
          price REAL,
          source TEXT NOT NULL DEFAULT 'recognition_order_items',
          occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_test_product_catalog_normalized_code
          ON test_product_catalog(normalized_code);
      `);

      const upsert = database.prepare(`
        INSERT INTO test_product_catalog (
          product_code, normalized_code, product_name, spec, unit, price,
          source, occurrence_count, active, created_at, updated_at
        ) VALUES (?, ?, '', '', ?, NULL, 'recognition_order_items', ?, 1, ?, ?)
        ON CONFLICT(normalized_code) DO UPDATE SET
          product_code = excluded.product_code,
          unit = excluded.unit,
          source = excluded.source,
          occurrence_count = excluded.occurrence_count,
          active = 1,
          updated_at = excluded.updated_at
      `);

      for (const product of products) {
        upsert.run(
          product.product_code,
          product.normalized_code,
          product.unit,
          product.occurrence_count,
          now,
          now
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    verifyCatalog(database, products);
    verifyBackup(backupPath);
    console.log(`Test product catalog ready: ${products.length} product(s).`);
    console.log(`Backup: ${backupPath}`);
  } finally {
    database.close();
  }
}

function deriveProducts(database) {
  const rows = database.prepare(`
    SELECT id, model_raw, model_normalized, unit
    FROM recognition_order_items
    WHERE model_normalized <> ''
    ORDER BY id
  `).all();
  const groups = new Map();

  for (const row of rows) {
    const normalizedCode = String(row.model_normalized || "").trim();
    if (!normalizedCode) {
      continue;
    }

    if (!groups.has(normalizedCode)) {
      groups.set(normalizedCode, {
        normalized_code: normalizedCode,
        rawCounts: new Map(),
        unitCounts: new Map(),
        occurrence_count: 0
      });
    }

    const group = groups.get(normalizedCode);
    group.occurrence_count += 1;
    increment(group.rawCounts, String(row.model_raw || "").trim());

    const unit = String(row.unit || "").trim();
    if (isPlausibleUnit(unit)) {
      increment(group.unitCounts, unit);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      product_code: mostFrequent(group.rawCounts),
      normalized_code: group.normalized_code,
      unit: mostFrequent(group.unitCounts),
      occurrence_count: group.occurrence_count
    }))
    .sort((left, right) => left.normalized_code.localeCompare(right.normalized_code));
}

function verifyCatalog(database, products) {
  const expectedCodes = new Set(products.map((product) => product.normalized_code));
  const stored = database.prepare(`
    SELECT normalized_code, product_code, occurrence_count
    FROM test_product_catalog
    WHERE active = 1
    ORDER BY normalized_code
  `).all();
  const storedCodes = new Set(stored.map((product) => product.normalized_code));

  if (stored.length !== products.length) {
    throw new Error(
      `Catalog verification failed: expected ${products.length} active rows, found ${stored.length}.`
    );
  }

  for (const code of expectedCodes) {
    if (!storedCodes.has(code)) {
      throw new Error(`Catalog verification failed: missing ${code}.`);
    }
  }

  const duplicates = database.prepare(`
    SELECT normalized_code, COUNT(*) AS count
    FROM test_product_catalog
    GROUP BY normalized_code
    HAVING COUNT(*) > 1
  `).all();
  if (duplicates.length) {
    throw new Error(`Catalog verification failed: duplicate normalized codes found.`);
  }

  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`Database integrity check failed: ${integrity.integrity_check}`);
  }
}

function printPreview(products) {
  console.table(products.map((product) => ({
    product_code: product.product_code,
    normalized_code: product.normalized_code,
    unit: product.unit,
    occurrences: product.occurrence_count
  })));
}

function increment(counts, value) {
  if (!value) {
    return;
  }
  counts.set(value, (counts.get(value) || 0) + 1);
}

function mostFrequent(counts) {
  let selected = "";
  let selectedCount = -1;
  for (const [value, count] of counts) {
    if (count > selectedCount) {
      selected = value;
      selectedCount = count;
    }
  }
  return selected;
}

function isPlausibleUnit(unit) {
  return Boolean(unit && /[\p{L}\p{N}]/u.test(unit));
}

function verifyBackup(backupPath) {
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      throw new Error(`Backup integrity check failed: ${integrity.integrity_check}`);
    }
  } finally {
    backup.close();
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
