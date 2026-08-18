import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachmentDir,
  clearImportedMailCache,
  ensureStorage,
  getMailConfig,
  getPublicMailConfig,
  importInbox,
  loadDotEnv,
  readStoredMails,
  saveMailboxConfig,
  sendSmtpMail
} from "./mail-service.mjs";
import { extractEmailContent } from "./content-extractor.mjs";
import { analyzeOrderContent } from "./order-analysis-service.mjs";
import { generateOrderDraft } from "./llm-order-draft-service.mjs";
import { orderRecognitionRepository } from "./order-recognition-repository.mjs";
import { productMatchingService } from "./product-matching-service.mjs";
import { mailWorkflowRepository } from "./mail-workflow-repository.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3080);
const orderDraftCache = new Map();
const orderDraftInFlight = new Map();
const maxOrderDraftCacheEntries = 100;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

function buildOrderDraftCacheKey(mail) {
  return createHash("sha256")
    .update(JSON.stringify({
      cache_version: 1,
      model: process.env.LLM_MODEL || "",
      base_url: process.env.LLM_BASE_URL || "",
      mail
    }))
    .digest("hex");
}

function readCachedOrderDraft(cacheKey) {
  const cached = orderDraftCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  orderDraftCache.delete(cacheKey);
  orderDraftCache.set(cacheKey, cached);
  return structuredClone(cached);
}

function writeCachedOrderDraft(cacheKey, payload) {
  orderDraftCache.delete(cacheKey);
  orderDraftCache.set(cacheKey, structuredClone(payload));
  while (orderDraftCache.size > maxOrderDraftCacheEntries) {
    const oldestKey = orderDraftCache.keys().next().value;
    orderDraftCache.delete(oldestKey);
  }
}

function isOrderDraftCacheEnabled() {
  const value = String(process.env.ORDER_DRAFT_CACHE_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

async function generateAndPersistOrderDraft(mail) {
  const extracted = await extractEmailContent(mail);
  const payload = await generateOrderDraft(extracted);
  let savedRecord = null;
  let matches = null;
  if (["success", "partial_success"].includes(payload.status) && payload.order_draft) {
    const record = await orderRecognitionRepository.saveOrderDraft(payload.order_draft);
    savedRecord = record;
    payload.persistence = {
      status: "saved",
      result_status: payload.status,
      recognition_order_id: record.id
    };
    try {
      matches = await productMatchingService.matchOrderRecognition(record.id);
      payload.persistence.product_matching = {
        status: "matched",
        summary: matches.summary
      };
    } catch (error) {
      console.error(`[product-matching] recognition_order_id=${record.id} error=${sanitizeError(error)}`);
      payload.persistence.product_matching = {
        status: "failed",
        error: sanitizeError(error)
      };
    }
  }
  payload.workflow = await recordRecognitionWorkflow(payload, savedRecord, matches);
  return payload;
}

function isCompleteDeepSeekOrder(payload, matches) {
  const products = payload?.order_draft?.products;
  const summary = matches?.summary || {};
  const totalItems = Number(matches?.total_items) || 0;
  return payload?.status === "success"
    && payload?.provider === "openai_compatible"
    && Array.isArray(products)
    && products.length > 0
    && products.every((product) =>
      String(product?.product_model || "").trim()
      && String(product?.product_name || "").trim()
      && Number.isFinite(Number(product?.quantity))
      && Number(product.quantity) > 0
      && String(product?.unit || "").trim()
      && Number(product?.confidence) >= 0.8
      && String(product?.evidence?.source || "").trim()
      && String(product?.evidence?.raw_text || "").trim()
    )
    && totalItems === products.length
    && Number(summary.exact_match) === totalItems
    && Number(summary.fuzzy_match) === 0
    && Number(summary.no_match) === 0
    && Number(summary.need_manual_review) === 0;
}

function deriveWorkflow(payload, record, matches) {
  if (!["success", "partial_success"].includes(payload?.status) || !payload?.order_draft) {
    return {
      status: "recognition_failed",
      reason: payload?.error || "DeepSeek 未返回可用的订单识别结果"
    };
  }
  if (!record || !matches) {
    return {
      status: "manual_review",
      reason: "订单结果尚未完成保存或产品匹配，需要人工核验"
    };
  }
  if (isCompleteDeepSeekOrder(payload, matches)) {
    return {
      status: "pending_confirmation",
      reason: "DeepSeek 识别和产品精确匹配已完成，邮件已核验"
    };
  }
  return {
    status: "manual_review",
    reason: payload.provider === "openai_compatible"
      ? "DeepSeek 结果不完整或产品匹配存在待核验项"
      : "本地快速识别结果需要 DeepSeek 或人工复核"
  };
}

async function recordRecognitionWorkflow(payload, record, matches) {
  const workflow = deriveWorkflow(payload, record, matches);
  return mailWorkflowRepository.upsertWorkflow({
    emailId: payload?.email_id,
    status: workflow.status,
    recognitionOrderId: record?.id ?? null,
    recognitionProvider: payload?.provider || "",
    recognitionStatus: payload?.status || "",
    reason: workflow.reason
  });
}

function addRequestPerformance(payload, { cacheEnabled, cacheHit, sharedRequest, durationMs }) {
  return {
    ...payload,
    processing: {
      ...(payload.processing || {}),
      cache_enabled: cacheEnabled,
      cache_hit: cacheHit,
      shared_request: sharedRequest,
      server_duration_ms: Number(durationMs.toFixed(1))
    }
  };
}

async function handleStaticFile(response, targetPath) {
  try {
    const content = await fs.readFile(targetPath);
    const extension = path.extname(targetPath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pdf": "application/pdf"
    };

    sendText(response, 200, content, types[extension] || "application/octet-stream");
  } catch {
    sendJson(response, 404, { error: `找不到文件: ${path.basename(targetPath)}` });
  }
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sanitizeError(error) {
  const message = error?.message || "服务异常";
  if (/^IMAP (认证失败|连接超时|配置错误|同步失败)/.test(message)) {
    return message;
  }
  if (/AUTH|LOGIN|password|auth code|授权码/i.test(message)) {
    return "认证失败或邮箱配置错误";
  }
  return message;
}

function findStoredMail(stored, emailId) {
  const decodedId = decodeURIComponent(emailId || "");
  return (Array.isArray(stored.mails) ? stored.mails : []).find((mail) => mail.id === decodedId);
}

async function updateWorkflowFromUser(emailId, requestedStatus) {
  const current = await mailWorkflowRepository.getWorkflowByEmailId(emailId);
  if (requestedStatus === "pending_recognition") {
    if (current?.status !== "not_applicable") {
      throw new Error("只有无需处理邮件才能恢复到待识别状态");
    }
  } else if (requestedStatus !== "not_applicable") {
    throw new Error("不支持的人工状态变更");
  }

  return mailWorkflowRepository.upsertWorkflow({
    emailId,
    status: requestedStatus,
    reason: requestedStatus === "not_applicable"
      ? "人工标记为无需处理"
      : "已恢复到待识别状态"
  });
}

function normalizeReviewNote(value) {
  const note = String(value || "").trim();
  if (note.length > 1000) {
    throw new Error("核验备注不能超过 1000 个字符");
  }
  return note;
}

function canCompleteManualReview(productMatches) {
  const summary = productMatches?.summary || {};
  const totalItems = Number(productMatches?.total_items) || 0;
  return totalItems > 0
    && Number(summary.exact_match) === totalItems
    && Number(summary.fuzzy_match) === 0
    && Number(summary.no_match) === 0
    && Number(summary.need_manual_review) === 0;
}

async function updateManualReviewFromUser(emailId, body) {
  const current = await mailWorkflowRepository.getWorkflowByEmailId(emailId);
  if (current?.status !== "manual_review") {
    throw new Error("只有人工核验中的邮件可以修改核验结果");
  }

  const reviewNote = body?.review_note !== undefined
    ? normalizeReviewNote(body.review_note)
    : current.review_note || "";
  const confirmations = Array.isArray(body?.confirmations) ? body.confirmations : [];
  const itemEdit = body?.item_edit && typeof body.item_edit === "object"
    ? body.item_edit
    : null;
  if (itemEdit && confirmations.length) {
    throw new Error("请先保存识别信息修改，再确认产品候选");
  }
  let recognitionOrderId = Number(current.recognition_order_id) || 0;
  if (!recognitionOrderId) {
    const recognition = await orderRecognitionRepository.getOrderRecognitionByEmailId(emailId);
    recognitionOrderId = Number(recognition?.id) || 0;
  }
  if (!recognitionOrderId) {
    throw new Error("该邮件没有可供人工核验的订单识别结果");
  }

  let productMatches;
  if (itemEdit) {
    const updatedOrder = await orderRecognitionRepository.updateOrderRecognitionItem(recognitionOrderId, {
      recognitionItemId: itemEdit.recognition_item_id,
      productModel: itemEdit.product_model,
      quantity: itemEdit.quantity,
      unit: itemEdit.unit
    });
    if (!updatedOrder) {
      throw new Error("待修改的产品不存在");
    }
    recognitionOrderId = updatedOrder.id;
    productMatches = await productMatchingService.matchOrderRecognition(recognitionOrderId);
  } else {
    productMatches = confirmations.length
      ? await productMatchingService.confirmManualMatches(recognitionOrderId, confirmations)
      : await productMatchingService.getOrderMatches(recognitionOrderId);
  }
  if (!productMatches) {
    throw new Error("产品匹配结果不存在，请重新识别后再试");
  }

  const complete = body?.complete === true;
  const canComplete = canCompleteManualReview(productMatches);
  if (complete && !canComplete) {
    throw new Error("仍有待核验或未匹配产品，暂时不能完成核验");
  }

  const workflow = await mailWorkflowRepository.upsertWorkflow({
    emailId,
    status: complete ? "pending_confirmation" : "manual_review",
    reason: complete ? "人工核验已完成，可删除邮件" : undefined,
    reviewNote
  });
  return { workflow, productMatches, can_complete: canComplete };
}

await loadDotEnv();
await ensureStorage();
await orderRecognitionRepository.ensureStorage();
await productMatchingService.ensureStorage();
await mailWorkflowRepository.ensureStorage();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "GET" && url.pathname === "/") {
      await handleStaticFile(response, path.join(__dirname, "index.html"));
      return;
    }

    if (
      request.method === "GET"
      && ["/mail-category-classifier.js", "/mail-data.js"].includes(url.pathname)
    ) {
      await handleStaticFile(response, path.join(__dirname, path.basename(url.pathname)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mail/config") {
      sendJson(response, 200, getPublicMailConfig(getMailConfig()));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/mail/config") {
      const body = await readRequestBody(request);
      try {
        const config = await saveMailboxConfig(body);
        const clearImportedMails = body?.clear_imported_mails === true;
        if (clearImportedMails) {
          await clearImportedMailCache();
        }
        sendJson(response, 200, { ok: true, config, clear_imported_mails: clearImportedMails });
      } catch (error) {
        sendJson(response, 400, { error: sanitizeError(error) });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mail-workflows") {
      const records = await mailWorkflowRepository.listWorkflows();
      sendJson(response, 200, { records });
      return;
    }

    const manualReviewMatch = url.pathname.match(/^\/api\/mail\/(.+)\/manual-review$/);
    if (request.method === "PATCH" && manualReviewMatch) {
      const emailId = decodeURIComponent(manualReviewMatch[1] || "");
      const stored = await readStoredMails();
      if (!findStoredMail(stored, emailId)) {
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }
      const body = await readRequestBody(request);
      try {
        const result = await updateManualReviewFromUser(emailId, body);
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 409, { error: sanitizeError(error) });
      }
      return;
    }

    const workflowMatch = url.pathname.match(/^\/api\/mail\/(.+)\/workflow$/);
    if (request.method === "PUT" && workflowMatch) {
      const emailId = decodeURIComponent(workflowMatch[1] || "");
      const stored = await readStoredMails();
      if (!findStoredMail(stored, emailId)) {
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }
      const body = await readRequestBody(request);
      try {
        const record = await updateWorkflowFromUser(emailId, String(body?.status || "").trim());
        sendJson(response, 200, { record });
      } catch (error) {
        sendJson(response, 409, { error: sanitizeError(error) });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mail/list") {
      const stored = await readStoredMails();
      sendJson(response, 200, stored);
      return;
    }

    const savedOrderResultMatch = url.pathname.match(/^\/api\/mail\/(.+)\/order-result$/);
    if (request.method === "GET" && savedOrderResultMatch) {
      const emailId = decodeURIComponent(savedOrderResultMatch[1] || "");
      const recognition = await orderRecognitionRepository.getOrderRecognitionByEmailId(emailId);
      if (!recognition) {
        sendJson(response, 404, { error: "这封邮件没有已保存的订单识别结果" });
        return;
      }
      const productMatches = await productMatchingService.getOrderMatches(recognition.id);
      sendJson(response, 200, {
        recognition,
        product_matches: productMatches
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/order-recognitions") {
      const records = await orderRecognitionRepository.listOrderRecognitions();
      sendJson(response, 200, { records });
      return;
    }

    const productMatchesMatch = url.pathname.match(
      /^\/api\/order-recognitions\/(\d+)\/product-matches$/
    );
    if (request.method === "GET" && productMatchesMatch) {
      const result = await productMatchingService.getOrderMatches(
        Number(productMatchesMatch[1])
      );
      if (!result) {
        sendJson(response, 404, { error: "订单识别结果不存在" });
        return;
      }
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && productMatchesMatch) {
      const result = await productMatchingService.matchOrderRecognition(
        Number(productMatchesMatch[1])
      );
      if (!result) {
        sendJson(response, 404, { error: "订单识别结果不存在" });
        return;
      }
      sendJson(response, 200, result);
      return;
    }

    const recognitionMatch = url.pathname.match(/^\/api\/order-recognitions\/(\d+)$/);
    if (request.method === "GET" && recognitionMatch) {
      const record = await orderRecognitionRepository.getOrderRecognition(Number(recognitionMatch[1]));
      if (!record) {
        sendJson(response, 404, { error: "订单识别结果不存在" });
        return;
      }
      sendJson(response, 200, record);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mail/import") {
      const body = await readRequestBody(request);
      const payload = await importInbox(body);
      sendJson(response, 200, { ok: true, ...payload });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mail/send") {
      const body = await readRequestBody(request);
      const result = await sendSmtpMail(body);
      sendJson(response, 200, result);
      return;
    }

    const extractMatch = url.pathname.match(/^\/api\/mail\/(.+)\/extract-content$/);
    if (request.method === "POST" && extractMatch) {
      const emailId = extractMatch[1];
      const stored = await readStoredMails();
      const mail = findStoredMail(stored, emailId);
      if (!mail) {
        console.warn(`[extract-content] mail not found: ${decodeURIComponent(emailId || "")}`);
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }

      const payload = await extractEmailContent(mail);
      console.info(
        `[extract-content] email_id=${mail.id} blocks=${payload.content_blocks.length}`
      );
      sendJson(response, 200, payload);
      return;
    }

    const analyzeMatch = url.pathname.match(/^\/api\/mail\/(.+)\/analyze-order$/);
    if (request.method === "POST" && analyzeMatch) {
      const emailId = analyzeMatch[1];
      const stored = await readStoredMails();
      const mail = findStoredMail(stored, emailId);
      if (!mail) {
        console.warn(`[analyze-order] mail not found: ${decodeURIComponent(emailId || "")}`);
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }

      const extracted = await extractEmailContent(mail);
      const payload = analyzeOrderContent(extracted);
      console.info(
        `[analyze-order] email_id=${mail.id} quantities=${payload.quantities.length} business_type=${payload.business_type.code} product_type=${payload.product_type.code}`
      );
      sendJson(response, 200, payload);
      return;
    }

    const generateDraftMatch = url.pathname.match(/^\/api\/mail\/(.+)\/generate-order-draft$/);
    if (request.method === "POST" && generateDraftMatch) {
      const startedAt = performance.now();
      const emailId = generateDraftMatch[1];
      const stored = await readStoredMails();
      const mail = findStoredMail(stored, emailId);
      if (!mail) {
        console.warn(`[generate-order-draft] mail not found: ${decodeURIComponent(emailId || "")}`);
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }

      const cacheEnabled = isOrderDraftCacheEnabled();
      const cacheKey = cacheEnabled ? buildOrderDraftCacheKey(mail) : "";
      const cachedPayload = cacheEnabled ? readCachedOrderDraft(cacheKey) : null;
      if (cachedPayload) {
        const payload = addRequestPerformance(cachedPayload, {
          cacheEnabled,
          cacheHit: true,
          sharedRequest: false,
          durationMs: performance.now() - startedAt
        });
        console.info(
          `[generate-order-draft] email_id=${mail.id} status=${payload.status} products=${payload.order_draft?.products?.length || 0} mode=${payload.processing?.mode || "llm"} cache=hit duration_ms=${payload.processing.server_duration_ms}`
        );
        sendJson(response, 200, payload);
        return;
      }

      let generation = cacheEnabled ? orderDraftInFlight.get(cacheKey) : null;
      const sharedRequest = Boolean(generation);
      if (!generation) {
        generation = generateAndPersistOrderDraft(mail);
        if (cacheEnabled) {
          orderDraftInFlight.set(cacheKey, generation);
        }
      }

      let generatedPayload;
      try {
        generatedPayload = await generation;
      } finally {
        if (cacheEnabled && !sharedRequest) {
          orderDraftInFlight.delete(cacheKey);
        }
      }

      if (cacheEnabled && ["success", "partial_success"].includes(generatedPayload.status) && generatedPayload.order_draft) {
        writeCachedOrderDraft(cacheKey, generatedPayload);
      }
      const payload = addRequestPerformance(generatedPayload, {
        cacheEnabled,
        cacheHit: sharedRequest,
        sharedRequest,
        durationMs: performance.now() - startedAt
      });
      console.info(
        `[generate-order-draft] email_id=${mail.id} status=${payload.status} products=${payload.order_draft?.products?.length || 0} mode=${payload.processing?.mode || "llm"} cache=${cacheEnabled ? (payload.processing.cache_hit ? "hit" : "miss") : "disabled"} duration_ms=${payload.processing.server_duration_ms}`
      );
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/attachments/")) {
      const relativePath = decodeURIComponent(url.pathname.replace("/attachments/", ""));
      const targetPath = path.resolve(attachmentDir, relativePath);
      if (!targetPath.startsWith(attachmentDir)) {
        sendJson(response, 403, { error: "非法附件路径" });
        return;
      }
      await handleStaticFile(response, targetPath);
      return;
    }

    sendJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    console.error(`[server] ${sanitizeError(error)}`);
    sendJson(response, 500, { error: sanitizeError(error) });
  }
});

server.listen(port, host, () => {
  console.log(`OrderBridge server running at http://${host}:${port}`);
});
