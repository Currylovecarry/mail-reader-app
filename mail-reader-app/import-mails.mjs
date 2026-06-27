import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const alias = process.argv[2] || "cq7777@agent.qq.com";
const limit = Math.min(Math.max(Number(process.argv[3]) || 10, 1), 20);

const outputFile = path.join(__dirname, "mail-data.js");
const attachmentDir = path.join(__dirname, "imported-attachments");

async function ensureStorage() {
  await fs.mkdir(attachmentDir, { recursive: true });
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

    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim() || stderr.trim();
      let parsed = null;

      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (code === 0) {
        resolve({ parsed, stdout, stderr });
        return;
      }

      reject(new Error(parsed?.error?.message || text || `agently-cli 执行失败，退出码 ${code}`));
    });
  });
}

function pickList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidates = [
    payload?.data,
    payload?.data?.data,
    payload?.data?.messages,
    payload?.data?.items,
    payload?.messages,
    payload?.items,
    payload?.list
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function pickObject(payload) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === "object" ? payload : {};
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

function splitBody(text, html) {
  const source = text
    ? String(text)
    : String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(source)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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

  const newest = files.sort((left, right) => right.localeCompare(left))[0];
  return `./imported-attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(newest)}`;
}

async function normalizeMessage(item) {
  const messageId = item.id || item.message_id || item.msg_id;
  if (!messageId) {
    return null;
  }

  const readResult = await runAgently(["message", "+read", "--id", messageId]);
  const message = pickObject(readResult.parsed);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const normalizedAttachments = [];

  for (const attachment of attachments) {
    const localPath = await downloadAttachment(messageId, attachment);
    normalizedAttachments.push({
      name: attachment.filename || attachment.name || "附件",
      type: attachment.content_type || attachment.mime_type || "附件",
      previewPath: localPath || attachment.download_url || "",
      previewMode: detectPreviewMode(
        attachment.filename || attachment.name || "",
        attachment.content_type || attachment.mime_type || ""
      ),
      previewLabel: localPath ? "点击打开已下载附件" : "附件未下载，点击查看外链",
      summary: summarizeAttachment(attachment),
      downloadUrl: attachment.download_url || ""
    });
  }

  return {
    id: messageId,
    subject: message.subject || item.subject || "(无主题)",
    sender: normalizeParticipants(message.from || item.from || item.sender),
    recipients: normalizeParticipants(message.to || item.to || item.recipients),
    time:
      message.created_at ||
      message.received_at ||
      message.date ||
      item.created_at ||
      item.received_at ||
      item.date ||
      item.time ||
      "",
    listEmail:
      message.from?.[0]?.email ||
      message.from?.email ||
      message.from?.email ||
      item.from?.[0]?.email ||
      item.from?.email ||
      item.from?.email ||
      normalizeParticipants(message.from || item.from || item.sender),
    body: splitBody(message.text, message.html || message.body),
    attachments: normalizedAttachments.length
      ? normalizedAttachments
      : [
          {
            name: "无附件",
            type: "",
            previewPath: "",
            previewMode: "file",
            previewLabel: "",
            summary: []
          }
        ]
  };
}

async function main() {
  await ensureStorage();
  let items = [];

  // Prefer alias-scoped search first, then fall back to plain inbox listing.
  if (alias) {
    const searchResult = await runAgently([
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
    ]);
    items = pickList(searchResult.parsed);
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
    items = pickList(listResult.parsed);
  }

  const mails = [];

  for (const item of items) {
    const normalized = await normalizeMessage(item);
    if (normalized) {
      mails.push(normalized);
    }
  }

  const payload = {
    alias,
    importedAt: new Date().toISOString(),
    mails
  };

  await fs.writeFile(
    outputFile,
    `window.__IMPORTED_MAIL_DATA__ = ${JSON.stringify(payload, null, 2)};\n`,
    "utf8"
  );

  console.log(`已导入 ${mails.length} 封邮件到 ${outputFile}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
