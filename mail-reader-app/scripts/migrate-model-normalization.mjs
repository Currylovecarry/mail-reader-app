import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { normalizeModel } from "../order-recognition-repository.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const databasePath = path.join(appDirectory, "data", "order-recognition.db");
const backupDirectory = path.join(appDirectory, "data", "backups");
const applyMigration = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (applyMigration === dryRun) {
  console.error("Usage: node scripts/migrate-model-normalization.mjs --dry-run|--apply");
  process.exitCode = 1;
} else if (!fs.existsSync(databasePath)) {
  console.error(`Database not found: ${databasePath}`);
  process.exitCode = 1;
} else {
  migrate();
}

function migrate() {
  const database = new DatabaseSync(databasePath, { readOnly: dryRun });
  let backupPath = "";

  try {
    const changes = findNormalizationChanges(database);
    printChanges(changes);

    if (dryRun) {
      console.log(`Dry run complete: ${changes.length} row(s) would change.`);
      return;
    }

    if (!changes.length) {
      console.log("No historical model normalization changes are required.");
      return;
    }

    fs.mkdirSync(backupDirectory, { recursive: true });
    backupPath = path.join(
      backupDirectory,
      `order-recognition-before-model-normalization-${timestamp()}.db`
    );
    database.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);

    database.exec("BEGIN IMMEDIATE");
    try {
      const update = database.prepare(`
        UPDATE recognition_order_items
        SET model_normalized = ?
        WHERE id = ?
          AND model_normalized = ?
      `);

      for (const change of changes) {
        const result = update.run(
          change.new_normalized,
          change.id,
          change.model_normalized
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`Row ${change.id} changed concurrently; migration aborted.`);
        }
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const remainingChanges = findNormalizationChanges(database);
    if (remainingChanges.length) {
      throw new Error(
        `Verification failed: ${remainingChanges.length} row(s) still need migration.`
      );
    }

    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") {
      throw new Error(`Database integrity check failed: ${integrity.integrity_check}`);
    }

    verifyBackup(backupPath);
    console.log(`Migration complete: ${changes.length} row(s) updated.`);
    console.log(`Backup: ${backupPath}`);
  } finally {
    database.close();
  }
}

function findNormalizationChanges(database) {
  return database.prepare(`
    SELECT id, recognition_order_id, line_no, model_raw, model_normalized
    FROM recognition_order_items
    ORDER BY id
  `).all()
    .map((row) => ({
      ...row,
      new_normalized: normalizeModel(row.model_raw)
    }))
    .filter((row) => row.model_normalized !== row.new_normalized);
}

function printChanges(changes) {
  if (!changes.length) {
    console.log("No model normalization changes found.");
    return;
  }

  console.table(changes.map((change) => ({
    id: change.id,
    order_id: change.recognition_order_id,
    line_no: change.line_no,
    model_raw: change.model_raw,
    old_normalized: change.model_normalized,
    new_normalized: change.new_normalized
  })));
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
