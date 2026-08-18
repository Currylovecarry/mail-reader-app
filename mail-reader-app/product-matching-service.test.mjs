import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrderRecognitionRepository } from "./order-recognition-repository.mjs";
import { createProductMatchingService } from "./product-matching-service.mjs";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "product-matching-"));
const databasePath = path.join(temporaryDirectory, "recognition.db");
const orderRepository = createOrderRecognitionRepository({ databasePath });

try {
  const exactOrder = await orderRepository.saveOrderDraft({
    email_id: "exact_order",
    requirements: {},
    products: [{ product_model: "GN 675-50-M8", quantity: 10, unit: "个", confidence: 0.95 }]
  });
  const fuzzyOrder = await orderRepository.saveOrderDraft({
    email_id: "fuzzy_order",
    requirements: {},
    products: [{ product_model: "GN 675-55-M8", quantity: 10, unit: "个", confidence: 0.85 }]
  });
  orderRepository.close();

  const setup = new DatabaseSync(databasePath);
  setup.exec(`
    CREATE TABLE test_product_catalog (
      id INTEGER PRIMARY KEY,
      product_code TEXT NOT NULL,
      normalized_code TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL DEFAULT '',
      spec TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      price REAL,
      source TEXT NOT NULL DEFAULT 'test',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const now = new Date().toISOString();
  setup.prepare(`
    INSERT INTO test_product_catalog (
      product_code, normalized_code, unit, price, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("GN 675-50-M8", "GN675-50-M8", "个", 50, now, now);
  setup.prepare(`
    INSERT INTO test_product_catalog (
      product_code, normalized_code, unit, price, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("GN 675-60-M8", "GN675-60-M8", "个", 60, now, now);
  setup.close();

  const service = createProductMatchingService({ databasePath });
  const exact = await service.matchOrderRecognition(exactOrder.id);
  assert.equal(exact.summary.exact_match, 1);
  assert.equal(exact.items[0].match.review_status, "auto_confirmed");
  assert.equal(exact.items[0].match.selected_normalized_code, "GN675-50-M8");
  assert.equal(exact.preliminary_quote.status, "complete");
  assert.equal(exact.preliminary_quote.total_amount, 500);
  assert.equal(exact.preliminary_quote.lines[0].unit_price, 50);

  const fuzzy = await service.matchOrderRecognition(fuzzyOrder.id);
  assert.equal(fuzzy.summary.fuzzy_match, 1);
  assert.equal(fuzzy.items[0].match.need_manual_review, true);
  assert.equal(fuzzy.items[0].match.candidates.length, 2);
  assert.match(fuzzy.items[0].match.spec_warning, /size_conflict/);
  assert.equal(fuzzy.preliminary_quote.status, "unavailable");
  assert.equal(fuzzy.preliminary_quote.unpriced_items, 1);

  const persisted = await service.getOrderMatches(fuzzyOrder.id);
  assert.equal(persisted.items[0].match.candidates[0].rank, 1);

  const confirmed = await service.confirmManualMatches(fuzzyOrder.id, [{
    recognition_item_id: persisted.items[0].recognition_item_id,
    selected_product_id: persisted.items[0].match.candidates[1].product_id
  }]);
  assert.equal(confirmed.summary.exact_match, 1);
  assert.equal(confirmed.summary.need_manual_review, 0);
  assert.equal(confirmed.items[0].match.review_status, "confirmed");
  assert.equal(confirmed.items[0].match.selected_normalized_code, "GN675-60-M8");
  assert.equal(confirmed.preliminary_quote.status, "complete");
  assert.equal(confirmed.preliminary_quote.total_amount, 600);

  const batch = await service.previewAllOrderRecognitions();
  assert.deepEqual(
    {
      orders: batch.summary.orders,
      items: batch.summary.items,
      exact: batch.summary.exact_match,
      fuzzy: batch.summary.fuzzy_match
    },
    { orders: 2, items: 2, exact: 1, fuzzy: 1 }
  );
  service.close();
} finally {
  orderRepository.close();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("product-matching-service test passed");
