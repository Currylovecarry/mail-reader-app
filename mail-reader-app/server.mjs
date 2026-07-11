import { createServer } from "node:http";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3080);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "GET" && url.pathname === "/") {
      await handleStaticFile(response, path.join(__dirname, "index.html"));
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

    if (request.method === "GET" && url.pathname === "/api/order-recognitions") {
      const records = await orderRecognitionRepository.listOrderRecognitions();
      sendJson(response, 200, { records });
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
      const emailId = generateDraftMatch[1];
      const stored = await readStoredMails();
      const mail = findStoredMail(stored, emailId);
      if (!mail) {
        console.warn(`[generate-order-draft] mail not found: ${decodeURIComponent(emailId || "")}`);
        sendJson(response, 404, { error: "邮件不存在" });
        return;
      }

      const extracted = await extractEmailContent(mail);
      const payload = await generateOrderDraft(extracted);
      if (payload.status === "success" && payload.order_draft) {
        const record = await orderRecognitionRepository.saveOrderDraft(payload.order_draft);
        payload.persistence = {
          status: "saved",
          recognition_order_id: record.id
        };
      }
      console.info(
        `[generate-order-draft] email_id=${mail.id} status=${payload.status} products=${payload.order_draft?.products?.length || 0}`
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
  console.log(`Mail reader server running at http://${host}:${port}`);
});
