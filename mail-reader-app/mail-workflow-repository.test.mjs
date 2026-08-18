import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMailWorkflowRepository } from "./mail-workflow-repository.mjs";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mail-workflow-"));
const repository = createMailWorkflowRepository({
  databasePath: path.join(temporaryDirectory, "workflow.db")
});

try {
  const first = await repository.upsertWorkflow({
    emailId: "mail_001",
    status: "manual_review",
    recognitionOrderId: 42,
    recognitionProvider: "openai_compatible",
    recognitionStatus: "partial_success",
    reason: "型号需要人工确认"
  });
  assert.equal(first.status, "manual_review");
  assert.equal(first.recognition_order_id, 42);

  const updated = await repository.upsertWorkflow({
    emailId: "mail_001",
    status: "pending_confirmation",
    recognitionStatus: "success",
    reason: "识别结果等待人工确认"
  });
  assert.equal(updated.status, "pending_confirmation");
  assert.equal(updated.recognition_order_id, 42);
  assert.equal(updated.recognition_provider, "openai_compatible");
  assert.equal(updated.recognition_status, "success");

  await assert.rejects(
    repository.upsertWorkflow({ emailId: "mail_002", status: "unknown" }),
    /不支持的邮件处理状态/
  );
  assert.equal((await repository.listWorkflows()).length, 1);
} finally {
  repository.close();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("mail-workflow-repository test passed");
