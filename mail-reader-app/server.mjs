import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachmentDir,
  ensureStorage,
  getMailConfig,
  getPublicMailConfig,
  importInbox,
  loadDotEnv,
  readStoredMails,
  sendSmtpMail
} from "./mail-service.mjs";
import { extractEmailContent } from "./content-extractor.mjs";
import { analyzeOrderContent } from "./order-analysis-service.mjs";
import { generateOrderDraft } from "./llm-order-draft-service.mjs";
import { orderRecognitionRepository } from "./order-recognition-repository.mjs";
import { productMatchingService } from "./product-matching-service.mjs";

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
  if (["success", "partial_success"].includes(payload.status) && payload.order_draft) {
    const record = await orderRecognitionRepository.saveOrderDraft(payload.order_draft);
    payload.persistence = {
      status: "saved",
      result_status: payload.status,
      recognition_order_id: record.id
    };
    try {
      const matches = await productMatchingService.matchOrderRecognition(record.id);
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
  return payload;
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

await loadDotEnv();
await ensureStorage();
await orderRecognitionRepository.ensureStorage();
await productMatchingService.ensureStorage();

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
