import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrderRecognitionRepository } from "./order-recognition-repository.mjs";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "order-recognition-"));
const repository = createOrderRecognitionRepository({
  databasePath: path.join(temporaryDirectory, "recognition.db")
});

try {
  const saved = await repository.saveOrderDraft({
    email_id: "mail_001",
    requirements: {
      company: "澳洋公司",
      contact_person: "陈琪",
      phone: "13800000000",
      project_name: "自动化项目",
      delivery_terms: "EXW",
      delivery_date: "2026-08-01",
      destination: "苏州",
      payment_terms: "预付"
    },
    products: [
      { line_no: 1, product_model: "GN 425.1 NI 12", quantity: 2, unit: "PCS", confidence: 0.91 },
      { line_no: 2, product_model: "GN 136-NI_40_40_B_0_FREE", quantity: 3, unit: "PCS", confidence: 0.82 }
    ]
  });

  assert.equal(saved.email_id, "mail_001");
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[0].model_normalized, "GN425.1NI12");
  assert.equal(saved.items[1].model_normalized, "GN136-NI-40-40-B-0-FREE");
  assert.equal(saved.requirements.delivery_terms, "EXW");

  const updated = await repository.saveOrderDraft({
    email_id: "mail_001",
    requirements: { company: "澳洋公司" },
    products: [{ product_model: "GN 5334.4-80-M10", quantity: 6, unit: "个", confidence: 0.95 }]
  });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.items.length, 1);
  assert.equal(updated.items[0].model_raw, "GN 5334.4-80-M10");
  const loadedByEmailId = await repository.getOrderRecognitionByEmailId("mail_001");
  assert.equal(loadedByEmailId.id, saved.id);
  assert.equal(loadedByEmailId.items[0].model_normalized, "GN5334.4-80-M10");
  assert.equal(await repository.getOrderRecognitionByEmailId("missing_mail"), null);

  const duplicateLines = await repository.saveOrderDraft({
    email_id: "mail_duplicate_lines",
    requirements: { company: "混合附件客户" },
    products: [
      { line_no: 1, product_model: "AX-100", quantity: 12, unit: "件", confidence: 0.95 },
      { line_no: 2, product_model: "AX-200", quantity: 8, unit: "个", confidence: 0.95 },
      { line_no: 1, product_model: "", quantity: null, unit: "个", confidence: 0.65 },
      { line_no: 2, product_model: "", quantity: null, unit: "件", confidence: 0.65 }
    ]
  });

  assert.equal(duplicateLines.items.length, 4);
  assert.deepEqual(
    duplicateLines.items.map((item) => item.line_no),
    [1, 2, 3, 4]
  );

  const normalizationCases = await repository.saveOrderDraft({
    email_id: "mail_normalization_cases",
    requirements: {},
    products: [
      { product_model: "GN675–50—M8", quantity: 1, unit: "件", confidence: 0.9 },
      { product_model: "A-2024/88", quantity: 1, unit: "件", confidence: 0.9 }
    ]
  });

  assert.equal(normalizationCases.items[0].model_normalized, "GN675-50-M8");
  assert.equal(normalizationCases.items[1].model_normalized, "A-202488");
  assert.equal((await repository.listOrderRecognitions()).length, 3);
} finally {
  repository.close();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("order-recognition-repository test passed");
