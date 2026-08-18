import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDatabasePath = path.join(__dirname, "data", "order-recognition.db");

export const MAIL_WORKFLOW_STATUSES = Object.freeze([
  "pending_recognition",
  "pending_confirmation",
  "manual_review",
  "recognition_failed",
  "not_applicable",
  "processed"
]);

const validStatuses = new Set(MAIL_WORKFLOW_STATUSES);

export function createMailWorkflowRepository({ databasePath = defaultDatabasePath } = {}) {
  let database;

  async function ensureStorage() {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    if (database) return;

    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS mail_workflows (
        email_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN (
          'pending_recognition', 'pending_confirmation', 'manual_review',
          'recognition_failed', 'not_applicable', 'processed'
        )),
        recognition_order_id INTEGER,
        recognition_provider TEXT NOT NULL DEFAULT '',
        recognition_status TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        review_note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_mail_workflows_status
        ON mail_workflows(status, updated_at DESC);
    `);
    ensureColumn(database, "mail_workflows", "review_note", "TEXT NOT NULL DEFAULT ''");
  }

  async function listWorkflows() {
    await ensureStorage();
    return database.prepare(`
      SELECT email_id, status, recognition_order_id, recognition_provider,
        recognition_status, reason, review_note, updated_at
      FROM mail_workflows
      ORDER BY updated_at DESC, email_id ASC
    `).all().map(hydrateWorkflow);
  }

  async function getWorkflowByEmailId(emailId) {
    await ensureStorage();
    const row = database.prepare(`
      SELECT email_id, status, recognition_order_id, recognition_provider,
        recognition_status, reason, review_note, updated_at
      FROM mail_workflows
      WHERE email_id = ?
    `).get(normalizeEmailId(emailId));
    return row ? hydrateWorkflow(row) : null;
  }

  async function upsertWorkflow(input) {
    await ensureStorage();
    const emailId = normalizeEmailId(input?.emailId);
    if (!emailId) throw new Error("邮件状态缺少 email_id");

    const current = await getWorkflowByEmailId(emailId);
    const status = input?.status ?? current?.status ?? "pending_recognition";
    if (!validStatuses.has(status)) throw new Error("不支持的邮件处理状态");

    const record = {
      emailId,
      status,
      recognitionOrderId: input?.recognitionOrderId !== undefined
        ? nullablePositiveInteger(input.recognitionOrderId)
        : current?.recognition_order_id ?? null,
      recognitionProvider: input?.recognitionProvider !== undefined
        ? cleanText(input.recognitionProvider)
        : current?.recognition_provider ?? "",
      recognitionStatus: input?.recognitionStatus !== undefined
        ? cleanText(input.recognitionStatus)
        : current?.recognition_status ?? "",
      reason: input?.reason !== undefined ? cleanText(input.reason) : current?.reason ?? "",
      reviewNote: input?.reviewNote !== undefined
        ? cleanText(input.reviewNote)
        : current?.review_note ?? "",
      updatedAt: new Date().toISOString()
    };

    database.prepare(`
      INSERT INTO mail_workflows (
        email_id, status, recognition_order_id, recognition_provider,
        recognition_status, reason, review_note, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_id) DO UPDATE SET
        status = excluded.status,
        recognition_order_id = excluded.recognition_order_id,
        recognition_provider = excluded.recognition_provider,
        recognition_status = excluded.recognition_status,
        reason = excluded.reason,
        review_note = excluded.review_note,
        updated_at = excluded.updated_at
    `).run(
      record.emailId,
      record.status,
      record.recognitionOrderId,
      record.recognitionProvider,
      record.recognitionStatus,
      record.reason,
      record.reviewNote,
      record.updatedAt
    );

    return getWorkflowByEmailId(emailId);
  }

  function close() {
    database?.close();
    database = undefined;
  }

  return { ensureStorage, listWorkflows, getWorkflowByEmailId, upsertWorkflow, close };
}

function hydrateWorkflow(row) {
  return {
    email_id: row.email_id,
    status: row.status,
    recognition_order_id: row.recognition_order_id,
    recognition_provider: row.recognition_provider,
    recognition_status: row.recognition_status,
    reason: row.reason,
    review_note: row.review_note || "",
    updated_at: row.updated_at
  };
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function normalizeEmailId(value) {
  return String(value || "").trim();
}

function cleanText(value) {
  return String(value || "").trim();
}

function nullablePositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export const mailWorkflowRepository = createMailWorkflowRepository();
