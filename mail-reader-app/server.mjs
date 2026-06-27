import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3080);

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "imported-mails.json");
const attachmentDir = path.join(__dirname, "imported-attachments");

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(attachmentDir, { recursive: true });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

function runAgently(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("agently-cli", args, {
      cwd: __dirname,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const text = stdout.trim() || stderr.trim();
      let parsed = null;

      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (code === 0) {
        resolve({ code, stdout, stderr, parsed });
        return;
      }

      const errorMessage =
        parsed?.error?.message ||
        text ||
        `agently-cli 执行失败，退出码 ${code}`;

      reject(new Error(errorMessage));
    });
  });
}

function pickDataEnvelope(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidates = [
    payload.data,
    payload.data?.data,
    payload.data?.messages,
    payload.data?.items,
    payload.messages,
    payload.items,
    payload.list
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function pickObjectData(payload) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload && typeof payload === "object") {
    return payload;
  }

  return {};
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitPlainText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function summarizeAttachment(attachment) {
  const summary = [];
  if (attachment.size) {
    summary.push(`大小: ${attachment.size}`);
  }
  if (attachment.content_type || attachment.mime_type) {
    summary.push(`MIME: ${attachment.content_type || attachment.mime_type}`);
  }
  if (attachment.download_url && !attachment.attachment_id) {
    summary.push("该附件为外链大附件，页面不会自动下载。");
  }
  return summary;
}

function detectPreviewMode(fileName = "", mimeType = "") {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (
    lowerMime.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].some((ext) => lowerName.endsWith(ext))
  ) {
    return "image";
  }
  return "file";
}

async function downloadAttachment(messageId, attachment) {
  if (!attachment?.attachment_id) {
    return null;
  }

  const targetDir = path.join(attachmentDir, messageId);
  const relativeOutputDir = `./imported-attachments/${messageId}`;
  await fs.mkdir(targetDir, { recursive: true });

  await runAgently([
    "attachment",
    "+download",
    "--msg",
    messageId,
    "--att",
    attachment.attachment_id,
    "--output",
    relativeOutputDir
  ]);

  const files = await fs.readdir(targetDir);
  if (!files.length) {
    return null;
  }

  const newest = files
    .map((name) => ({ name, fullPath: path.join(targetDir, name) }))
    .sort((left, right) => right.name.localeCompare(left.name))[0];

  return {
    fileName: newest.name,
    filePath: newest.fullPath,
    webPath: `/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(newest.name)}`
  };
}

function normalizeParticipants(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.name && item?.email) {
          return `${item.name} <${item.email}>`;
        }
        return item?.email || item?.address || "";
      })
      .filter(Boolean)
      .join(", ");
  }

  if (value && typeof value === "object") {
    if (value.name && value.email) {
      return `${value.name} <${value.email}>`;
    }
    return value.email || value.address || "";
  }

  return String(value || "");
}

async function normalizeMessage(summaryItem) {
  const messageId = summaryItem.id || summaryItem.message_id || summaryItem.msg_id;
  if (!messageId) {
    return null;
  }

  const messageResult = await runAgently(["message", "+read", "--id", messageId]);
  const fullMessage = pickObjectData(messageResult.parsed);
  const attachments = Array.isArray(fullMessage.attachments) ? fullMessage.attachments : [];

  const normalizedAttachments = [];
  for (const attachment of attachments) {
    const downloaded = await downloadAttachment(messageId, attachment);
    normalizedAttachments.push({
      name: attachment.filename || attachment.name || downloaded?.fileName || "附件",
      type: attachment.content_type || attachment.mime_type || "附件",
      previewPath: downloaded?.webPath || "",
      previewMode: detectPreviewMode(
        attachment.filename || attachment.name || downloaded?.fileName || "",
        attachment.content_type || attachment.mime_type || ""
      ),
      previewLabel: downloaded ? "点击打开已下载附件" : "附件未下载，点击查看外链",
      summary: summarizeAttachment(attachment),
      downloadUrl: attachment.download_url || ""
    });
  }

  if (!normalizedAttachments.length) {
    normalizedAttachments.push({
      name: "无附件",
      type: "",
      previewPath: "",
      previewMode: "file",
      previewLabel: "",
      summary: []
    });
  }

  const bodyLines = fullMessage.text
    ? splitPlainText(fullMessage.text)
    : stripHtml(fullMessage.html || fullMessage.body || "");

  return {
    id: messageId,
    subject: fullMessage.subject || summaryItem.subject || "(无主题)",
    sender: normalizeParticipants(fullMessage.from || summaryItem.from || summaryItem.sender),
    recipients: normalizeParticipants(fullMessage.to || summaryItem.to || summaryItem.recipients),
    time:
      fullMessage.created_at ||
      fullMessage.received_at ||
      fullMessage.date ||
      summaryItem.created_at ||
      summaryItem.received_at ||
      summaryItem.date ||
      summaryItem.time ||
      "",
    listEmail:
      fullMessage.from?.[0]?.email ||
      fullMessage.from?.email ||
      summaryItem.from?.[0]?.email ||
      summaryItem.from?.email ||
      normalizeParticipants(fullMessage.from || summaryItem.from || summaryItem.sender),
    body: bodyLines.length ? bodyLines : ["(无正文)"],
    attachments: normalizedAttachments
  };
}

async function importInbox(alias, limit) {
  await ensureStorage();

  let items = [];

  if (alias) {
    const searchArgs = [
      "message",
      "+search",
      "--dir",
      "inbox",
      "--to",
      alias,
      "--search-in",
      "SEARCH_IN_ALL",
      "--limit",
      String(limit)
    ];
    const searchResult = await runAgently(searchArgs);
    items = pickDataEnvelope(searchResult.parsed);
  }

  if (!items.length) {
    const listResult = await runAgently([
      "message",
      "+list",
      "--dir",
      "inbox",
      "--limit",
      String(limit)
    ]);
    items = pickDataEnvelope(listResult.parsed);
  }

  const mails = [];

  for (const item of items) {
    const normalized = await normalizeMessage(item);
    if (normalized) {
      mails.push(normalized);
    }
  }

  await fs.writeFile(
    dataFile,
    JSON.stringify(
      {
        alias,
        importedAt: new Date().toISOString(),
        mails
      },
      null,
      2
    ),
    "utf8"
  );

  return mails;
}

async function readStoredMails() {
  try {
    const content = await fs.readFile(dataFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { mails: [] };
    }
    throw error;
  }
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
  } catch (error) {
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "GET" && url.pathname === "/") {
      await handleStaticFile(response, path.join(__dirname, "index.html"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mail/list") {
      const stored = await readStoredMails();
      sendJson(response, 200, stored);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mail/import") {
      const body = await readRequestBody(request);
      const alias = String(body.alias || "cq7777@agent.qq.com");
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);
      const mails = await importInbox(alias, limit);
      sendJson(response, 200, { ok: true, alias, mails });
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
    sendJson(response, 500, { error: error.message || "服务异常" });
  }
});

await ensureStorage();

server.listen(port, host, () => {
  console.log(`Mail reader server running at http://${host}:${port}`);
});
