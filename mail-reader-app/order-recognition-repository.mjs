import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDatabasePath = path.join(__dirname, "data", "order-recognition.db");

export function createOrderRecognitionRepository({ databasePath = defaultDatabasePath } = {}) {
  let database;

  async function ensureStorage() {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    if (database) {
      return;
    }

    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS recognition_orders (
        id INTEGER PRIMARY KEY,
        email_id TEXT NOT NULL UNIQUE,
        company TEXT NOT NULL DEFAULT '',
        contact_person TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        delivery_terms TEXT NOT NULL DEFAULT '',
        delivery_date TEXT NOT NULL DEFAULT '',
        destination TEXT NOT NULL DEFAULT '',
        payment_terms TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS recognition_order_items (
        id INTEGER PRIMARY KEY,
        recognition_order_id INTEGER NOT NULL REFERENCES recognition_orders(id) ON DELETE CASCADE,
        line_no INTEGER NOT NULL,
        model_raw TEXT NOT NULL,
        model_normalized TEXT NOT NULL,
        quantity REAL,
        unit TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        UNIQUE(recognition_order_id, line_no)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_recognition_order_items_model_normalized
        ON recognition_order_items(model_normalized);
    `);
  }

  async function saveOrderDraft(orderDraft) {
    await ensureStorage();
    const draft = normalizeOrderDraft(orderDraft);
    if (!draft.emailId) {
      throw new Error("订单识别结果缺少 email_id，无法保存");
    }

    const now = new Date().toISOString();
    let orderId;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO recognition_orders (
          email_id, company, contact_person, phone, project_name,
          delivery_terms, delivery_date, destination, payment_terms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email_id) DO UPDATE SET
          company = excluded.company,
          contact_person = excluded.contact_person,
          phone = excluded.phone,
          project_name = excluded.project_name,
          delivery_terms = excluded.delivery_terms,
          delivery_date = excluded.delivery_date,
          destination = excluded.destination,
          payment_terms = excluded.payment_terms,
          updated_at = excluded.updated_at
      `).run(
        draft.emailId,
        draft.requirements.company,
        draft.requirements.contactPerson,
        draft.requirements.phone,
        draft.requirements.projectName,
        draft.requirements.deliveryTerms,
        draft.requirements.deliveryDate,
        draft.requirements.destination,
        draft.requirements.paymentTerms,
        now,
        now
      );

      const order = database.prepare("SELECT id FROM recognition_orders WHERE email_id = ?").get(draft.emailId);
      database.prepare("DELETE FROM recognition_order_items WHERE recognition_order_id = ?").run(order.id);
      const insertItem = database.prepare(`
        INSERT INTO recognition_order_items (
          recognition_order_id, line_no, model_raw, model_normalized, quantity, unit, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      draft.items.forEach((item) => {
        insertItem.run(
          order.id,
          item.lineNo,
          item.modelRaw,
          item.modelNormalized,
          item.quantity,
          item.unit,
          item.confidence
        );
      });

      orderId = order.id;
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction may already have been closed before a later error.
      }
      throw error;
    }

    return getOrderRecognition(orderId);
  }

  async function listOrderRecognitions() {
    await ensureStorage();
    const orders = database.prepare("SELECT * FROM recognition_orders ORDER BY updated_at DESC, id DESC").all();
    return orders.map((order) => hydrateOrder(order));
  }

  async function getOrderRecognition(id) {
    await ensureStorage();
    const order = database.prepare("SELECT * FROM recognition_orders WHERE id = ?").get(id);
    return order ? hydrateOrder(order) : null;
  }

  function hydrateOrder(order) {
    const items = database.prepare(`
      SELECT line_no, model_raw, model_normalized, quantity, unit, confidence
      FROM recognition_order_items
      WHERE recognition_order_id = ?
      ORDER BY line_no ASC, id ASC
    `).all(order.id).map((item) => ({
      line_no: item.line_no,
      model_raw: item.model_raw,
      model_normalized: item.model_normalized,
      quantity: item.quantity,
      unit: item.unit,
      confidence: item.confidence
    }));

    return {
      id: order.id,
      email_id: order.email_id,
      requirements: {
        company: order.company,
        contact_person: order.contact_person,
        phone: order.phone,
        project_name: order.project_name,
        delivery_terms: order.delivery_terms,
        delivery_date: order.delivery_date,
        destination: order.destination,
        payment_terms: order.payment_terms
      },
      items,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  function close() {
    database?.close();
    database = undefined;
  }

  return {
    ensureStorage,
    saveOrderDraft,
    listOrderRecognitions,
    getOrderRecognition,
    close
  };
}

function normalizeOrderDraft(orderDraft) {
  const requirements = orderDraft?.requirements || {};
  const items = Array.isArray(orderDraft?.products) ? orderDraft.products : [];

  return {
    emailId: String(orderDraft?.email_id || "").trim(),
    requirements: {
      company: cleanText(requirements.company),
      contactPerson: cleanText(requirements.contact_person),
      phone: cleanText(requirements.phone),
      projectName: cleanText(requirements.project_name),
      deliveryTerms: cleanText(requirements.delivery_terms),
      deliveryDate: cleanText(requirements.delivery_date),
      destination: cleanText(requirements.destination),
      paymentTerms: cleanText(requirements.payment_terms)
    },
    items: items.map((item, index) => ({
      lineNo: positiveInteger(item?.line_no) || index + 1,
      modelRaw: cleanText(item?.product_model),
      modelNormalized: normalizeModel(item?.product_model),
      quantity: nullableNumber(item?.quantity),
      unit: cleanText(item?.unit),
      confidence: clampConfidence(item?.confidence)
    })).filter((item) => item.modelRaw || item.quantity !== null || item.unit)
  };
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeModel(value) {
  return cleanText(value).toUpperCase().replace(/\s+/g, "");
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

export const orderRecognitionRepository = createOrderRecognitionRepository();
