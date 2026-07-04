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

await loadDotEnv();
await ensureStorage();

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
    sendJson(response, 500, { error: sanitizeError(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Mail reader server running at http://${host}:${port}`);
});
