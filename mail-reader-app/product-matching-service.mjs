import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { matchProduct } from "./product-matcher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDatabasePath = path.join(__dirname, "data", "order-recognition.db");

export function createProductMatchingService({ databasePath = defaultDatabasePath } = {}) {
  let database;
  let storageEnsured = false;

  async function openDatabase() {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    if (database) {
      return;
    }

    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const catalogTable = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'test_product_catalog'
    `).get();
    if (!catalogTable) {
      database.close();
      database = undefined;
      throw new Error("测试产品库表 test_product_catalog 不存在");
    }
  }

  async function ensureStorage() {
    await openDatabase();
    if (storageEnsured) {
      return;
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS product_match_results (
        id INTEGER PRIMARY KEY,
        recognition_item_id INTEGER NOT NULL UNIQUE
          REFERENCES recognition_order_items(id) ON DELETE CASCADE,
        query_model_raw TEXT NOT NULL,
        query_normalized_code TEXT NOT NULL,
        match_status TEXT NOT NULL
          CHECK (match_status IN ('exact_match', 'fuzzy_match', 'no_match')),
        match_method TEXT NOT NULL,
        final_score REAL NOT NULL DEFAULT 0,
        spec_warning TEXT NOT NULL DEFAULT '',
        need_manual_review INTEGER NOT NULL DEFAULT 1
          CHECK (need_manual_review IN (0, 1)),
        review_reason TEXT NOT NULL DEFAULT '',
        selected_product_id INTEGER
          REFERENCES test_product_catalog(id) ON DELETE SET NULL,
        review_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (review_status IN ('pending', 'auto_confirmed', 'confirmed', 'rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS product_match_candidates (
        id INTEGER PRIMARY KEY,
        match_result_id INTEGER NOT NULL
          REFERENCES product_match_results(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL
          REFERENCES test_product_catalog(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
        fuzzy_score REAL NOT NULL,
        spec_score REAL NOT NULL,
        final_score REAL NOT NULL,
        match_reason TEXT NOT NULL DEFAULT '',
        UNIQUE(match_result_id, rank),
        UNIQUE(match_result_id, product_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_product_match_results_status
        ON product_match_results(match_status, need_manual_review);

      CREATE INDEX IF NOT EXISTS idx_product_match_candidates_result
        ON product_match_candidates(match_result_id, rank);
    `);
    storageEnsured = true;
  }

  async function previewOrderRecognition(recognitionOrderId) {
    await openDatabase();
    const order = findOrder(recognitionOrderId);
    if (!order) {
      return null;
    }
    const catalog = listActiveCatalog();
    const items = listRecognitionItems(recognitionOrderId).map((item) => ({
      ...item,
      match: matchProduct(item, catalog)
    }));
    return buildOrderMatchPayload(order, items);
  }

  async function matchOrderRecognition(recognitionOrderId) {
    await ensureStorage();
    const preview = await previewOrderRecognition(recognitionOrderId);
    if (!preview) {
      return null;
    }

    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of preview.items) {
        saveItemMatch(item, now);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return getOrderMatches(recognitionOrderId);
  }

  async function previewAllOrderRecognitions() {
    await openDatabase();
    const orders = database.prepare(`
      SELECT id
      FROM recognition_orders
      ORDER BY id
    `).all();
    const results = [];
    for (const order of orders) {
      results.push(await previewOrderRecognition(order.id));
    }
    return summarizeBatch(results);
  }

  async function matchAllOrderRecognitions() {
    await ensureStorage();
    const orders = database.prepare(`
      SELECT id
      FROM recognition_orders
      ORDER BY id
    `).all();
    const results = [];
    for (const order of orders) {
      results.push(await matchOrderRecognition(order.id));
    }
    return summarizeBatch(results);
  }

  async function getOrderMatches(recognitionOrderId) {
    await ensureStorage();
    const order = findOrder(recognitionOrderId);
    if (!order) {
      return null;
    }

    const items = database.prepare(`
      SELECT
        i.id AS recognition_item_id,
        i.line_no,
        i.model_raw,
        i.model_normalized,
        i.quantity,
        i.unit,
        i.confidence,
        r.id AS match_result_id,
        r.match_status,
        r.match_method,
        r.final_score,
        r.spec_warning,
        r.need_manual_review,
        r.review_reason,
        r.selected_product_id,
        r.review_status,
        p.product_code AS selected_product_code,
        p.normalized_code AS selected_normalized_code
      FROM recognition_order_items i
      LEFT JOIN product_match_results r ON r.recognition_item_id = i.id
      LEFT JOIN test_product_catalog p ON p.id = r.selected_product_id
      WHERE i.recognition_order_id = ?
      ORDER BY i.line_no, i.id
    `).all(recognitionOrderId).map((item) => ({
      recognition_item_id: item.recognition_item_id,
      line_no: item.line_no,
      model_raw: item.model_raw,
      model_normalized: item.model_normalized,
      quantity: item.quantity,
      unit: item.unit,
      confidence: item.confidence,
      match: item.match_result_id ? {
        id: item.match_result_id,
        match_status: item.match_status,
        match_method: item.match_method,
        final_score: item.final_score,
        spec_warning: item.spec_warning,
        need_manual_review: Boolean(item.need_manual_review),
        review_reason: item.review_reason,
        selected_product_id: item.selected_product_id,
        selected_product_code: item.selected_product_code || "",
        selected_normalized_code: item.selected_normalized_code || "",
        review_status: item.review_status,
        candidates: listCandidates(item.match_result_id)
      } : null
    }));

    return buildOrderMatchPayload(order, items);
  }

  function close() {
    database?.close();
    database = undefined;
    storageEnsured = false;
  }

  function findOrder(recognitionOrderId) {
    return database.prepare(`
      SELECT id, email_id, created_at, updated_at
      FROM recognition_orders
      WHERE id = ?
    `).get(recognitionOrderId);
  }

  function listRecognitionItems(recognitionOrderId) {
    return database.prepare(`
      SELECT
        id AS recognition_item_id,
        line_no,
        model_raw,
        model_normalized,
        quantity,
        unit,
        confidence
      FROM recognition_order_items
      WHERE recognition_order_id = ?
      ORDER BY line_no, id
    `).all(recognitionOrderId);
  }

  function listActiveCatalog() {
    return database.prepare(`
      SELECT
        id,
        product_code,
        normalized_code,
        product_name,
        spec,
        unit,
        price,
        active
      FROM test_product_catalog
      WHERE active = 1
      ORDER BY normalized_code
    `).all();
  }

  function saveItemMatch(item, now) {
    const match = item.match;
    database.prepare(`
      INSERT INTO product_match_results (
        recognition_item_id, query_model_raw, query_normalized_code,
        match_status, match_method, final_score, spec_warning,
        need_manual_review, review_reason, selected_product_id,
        review_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(recognition_item_id) DO UPDATE SET
        query_model_raw = excluded.query_model_raw,
        query_normalized_code = excluded.query_normalized_code,
        match_status = excluded.match_status,
        match_method = excluded.match_method,
        final_score = excluded.final_score,
        spec_warning = excluded.spec_warning,
        need_manual_review = excluded.need_manual_review,
        review_reason = excluded.review_reason,
        selected_product_id = excluded.selected_product_id,
        review_status = excluded.review_status,
        updated_at = excluded.updated_at
    `).run(
      item.recognition_item_id,
      item.model_raw,
      item.model_normalized,
      match.match_status,
      match.match_method,
      match.final_score,
      match.spec_warning,
      match.need_manual_review ? 1 : 0,
      match.review_reason,
      match.selected_product_id,
      match.review_status,
      now,
      now
    );

    const result = database.prepare(`
      SELECT id
      FROM product_match_results
      WHERE recognition_item_id = ?
    `).get(item.recognition_item_id);
    database.prepare(`
      DELETE FROM product_match_candidates
      WHERE match_result_id = ?
    `).run(result.id);

    const insertCandidate = database.prepare(`
      INSERT INTO product_match_candidates (
        match_result_id, product_id, rank, fuzzy_score,
        spec_score, final_score, match_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of match.candidates) {
      insertCandidate.run(
        result.id,
        candidate.product_id,
        candidate.rank,
        candidate.fuzzy_score,
        candidate.spec_score,
        candidate.final_score,
        candidate.match_reason
      );
    }
  }

  function listCandidates(matchResultId) {
    return database.prepare(`
      SELECT
        c.product_id,
        c.rank,
        p.product_code,
        p.normalized_code,
        p.product_name,
        p.spec,
        p.unit,
        p.price,
        c.fuzzy_score,
        c.spec_score,
        c.final_score,
        c.match_reason
      FROM product_match_candidates c
      JOIN test_product_catalog p ON p.id = c.product_id
      WHERE c.match_result_id = ?
      ORDER BY c.rank
    `).all(matchResultId);
  }

  return {
    ensureStorage,
    previewOrderRecognition,
    matchOrderRecognition,
    previewAllOrderRecognitions,
    matchAllOrderRecognitions,
    getOrderMatches,
    close
  };
}

function buildOrderMatchPayload(order, items) {
  const summary = summarizeItems(items);
  return {
    recognition_order_id: order.id,
    email_id: order.email_id,
    total_items: items.length,
    summary,
    preliminary_quote: buildPreliminaryQuote(items),
    items
  };
}

function buildPreliminaryQuote(items) {
  const lines = [];
  for (const item of items) {
    const match = item.match;
    const quantity = Number(item.quantity);
    if (
      !match
      || match.match_status !== "exact_match"
      || match.need_manual_review
      || !Number.isFinite(quantity)
    ) {
      continue;
    }

    const candidate = (match.candidates || []).find(
      (value) => value.product_id === match.selected_product_id
    );
    if (
      !candidate
      || candidate.price === null
      || candidate.price === undefined
      || candidate.price === ""
    ) {
      continue;
    }
    const unitPrice = Number(candidate.price);
    if (!Number.isFinite(unitPrice)) {
      continue;
    }

    lines.push({
      recognition_item_id: item.recognition_item_id,
      line_no: item.line_no,
      product_id: candidate.product_id,
      product_code: candidate.product_code,
      quantity,
      unit: item.unit,
      unit_price: roundCurrency(unitPrice),
      line_total: roundCurrency(quantity * unitPrice)
    });
  }

  const totalItems = items.length;
  const pricedItems = lines.length;
  return {
    currency: "CNY",
    status: !totalItems
      ? "unavailable"
      : pricedItems === totalItems
        ? "complete"
        : pricedItems
          ? "partial"
          : "unavailable",
    total_items: totalItems,
    priced_items: pricedItems,
    unpriced_items: Math.max(0, totalItems - pricedItems),
    total_amount: roundCurrency(
      lines.reduce((total, line) => total + line.line_total, 0)
    ),
    disclaimer: "测试价格，未含税费及运费，正式报价需人工确认",
    lines
  };
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function summarizeItems(items) {
  const summary = {
    exact_match: 0,
    fuzzy_match: 0,
    no_match: 0,
    need_manual_review: 0
  };
  for (const item of items) {
    const match = item.match;
    if (!match) {
      continue;
    }
    summary[match.match_status] += 1;
    if (match.need_manual_review) {
      summary.need_manual_review += 1;
    }
  }
  return summary;
}

function summarizeBatch(results) {
  const validResults = results.filter(Boolean);
  const summary = {
    orders: validResults.length,
    items: 0,
    exact_match: 0,
    fuzzy_match: 0,
    no_match: 0,
    need_manual_review: 0
  };
  for (const result of validResults) {
    summary.items += result.total_items;
    summary.exact_match += result.summary.exact_match;
    summary.fuzzy_match += result.summary.fuzzy_match;
    summary.no_match += result.summary.no_match;
    summary.need_manual_review += result.summary.need_manual_review;
  }
  return { summary, orders: validResults };
}

export const productMatchingService = createProductMatchingService();
