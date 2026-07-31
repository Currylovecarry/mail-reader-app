import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createProductMatchingService } from "../product-matching-service.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const databasePath = path.join(appDirectory, "data", "order-recognition.db");
const backupDirectory = path.join(appDirectory, "data", "backups");
const applyChanges = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (applyChanges === dryRun) {
  console.error("Usage: node scripts/backfill-product-matches.mjs --dry-run|--apply");
  process.exitCode = 1;
} else if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exitCode = 1;
} else {
  await backfill();
}

async function backfill() {
  const service = createProductMatchingService({ databasePath });
  try {
    if (dryRun) {
      const preview = await service.previewAllOrderRecognitions();
      printSummary("Dry run", preview);
      return;
    }

    const backupPath = createBackup();
    const result = await service.matchAllOrderRecognitions();
    printSummary("Backfill complete", result);
    verifyDatabase(result.summary.items);
    verifyBackup(backupPath);
    console.log(`Backup: ${backupPath}`);
  } finally {
    service.close();
  }
}

function createBackup() {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `order-recognition-before-product-match-backfill-${timestamp()}.db`
  );
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  } finally {
    database.close();
  }
  return backupPath;
}

function verifyDatabase(expectedResults) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const resultCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM product_match_results
    `).get();
    if (Number(resultCount.count) !== expectedResults) {
      throw new Error(
        `Backfill verification failed: expected ${expectedResults} results, found ${resultCount.count}.`
      );
    }

    const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length) {
      throw new Error(`Foreign key verification failed.`);
    }
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      throw new Error(`Database integrity check failed: ${integrity.integrity_check}`);
    }
  } finally {
    database.close();
  }
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

function printSummary(label, result) {
  console.log(`${label}:`);
  console.table([result.summary]);
  console.table(result.orders.map((order) => ({
    recognition_order_id: order.recognition_order_id,
    items: order.total_items,
    exact_match: order.summary.exact_match,
    fuzzy_match: order.summary.fuzzy_match,
    no_match: order.summary.no_match,
    need_manual_review: order.summary.need_manual_review
  })));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
