import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const dataDir = path.join(__dirname, "data");
export const dataFile = path.join(dataDir, "imported-mails.json");
export const attachmentDir = path.join(__dirname, "imported-attachments");

const defaultAgentAlias = "cq7777@agent.qq.com";

export async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(attachmentDir, { recursive: true });
}

export async function loadDotEnv() {
  const envFile = path.join(__dirname, ".env");
  let content = "";

  try {
    content = await fs.readFile(envFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getMailConfig() {
  const mode = process.env.MAIL_MODE || "agent";
  const email = process.env.MAIL_EMAIL || "";

  return {
    mode,
    agent: {
      alias: process.env.AGENT_MAIL_ALIAS || process.env.MAIL_AGENT_ALIAS || defaultAgentAlias
    },
    imap: {
      email,
      host: process.env.IMAP_HOST || "",
      port: toNumber(process.env.IMAP_PORT, 993),
      secure: toBoolean(process.env.IMAP_SECURE, true),
      mailbox: process.env.IMAP_MAILBOX || "INBOX",
      limit: Math.min(Math.max(toNumber(process.env.MAIL_SYNC_LIMIT, 50), 1), 200),
      days: Math.min(Math.max(toNumber(process.env.MAIL_SYNC_DAYS, 3650), 1), 3650),
      timeoutMs: Math.min(Math.max(toNumber(process.env.IMAP_TIMEOUT_MS, 30000), 5000), 120000),
      authCode: process.env.MAIL_AUTH_CODE || ""
    },
    smtp: {
      email,
      host: process.env.SMTP_HOST || "",
      port: toNumber(process.env.SMTP_PORT, 465),
      secure: toBoolean(process.env.SMTP_SECURE, true),
      authCode: process.env.MAIL_AUTH_CODE || ""
    }
  };
}

export function getPublicMailConfig(config = getMailConfig()) {
  return {
    mode: config.mode,
    email: config.imap.email || config.smtp.email || "",
    imap: {
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      mailbox: config.imap.mailbox,
      limit: config.imap.limit,
      days: config.imap.days,
      configured: Boolean(config.imap.email && config.imap.host && config.imap.authCode)
    },
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      configured: Boolean(config.smtp.email && config.smtp.host && config.smtp.authCode)
    },
    agent: {
      alias: config.agent.alias
    }
  };
}

function assertImapConfig(config) {
  const missing = [];
  for (const [key, value] of [
    ["MAIL_EMAIL", config.imap.email],
    ["IMAP_HOST", config.imap.host],
    ["IMAP_PORT", config.imap.port],
    ["MAIL_AUTH_CODE", config.imap.authCode]
  ]) {
    if (!value) {
      missing.push(key);
    }
  }
  if (missing.length) {
    throw new ImapConfigError(`IMAP 配置不完整: ${missing.join(", ")}`);
  }
}

class ImapAuthError extends Error {
  constructor(message = "IMAP 认证失败") {
    super(message);
    this.name = "ImapAuthError";
  }
}

class ImapConfigError extends Error {
  constructor(message = "IMAP 配置错误") {
    super(message);
    this.name = "ImapConfigError";
  }
}

class ImapTimeoutError extends Error {
  constructor(message = "IMAP 连接超时") {
    super(message);
    this.name = "ImapTimeoutError";
  }
}

function assertSmtpConfig(config) {
  const missing = [];
  for (const [key, value] of [
    ["MAIL_EMAIL", config.smtp.email],
    ["SMTP_HOST", config.smtp.host],
    ["SMTP_PORT", config.smtp.port],
    ["MAIL_AUTH_CODE", config.smtp.authCode]
  ]) {
    if (!value) {
      missing.push(key);
    }
  }
  if (missing.length) {
    throw new Error(`SMTP 配置不完整: ${missing.join(", ")}`);
  }
}

export async function readStoredMails() {
  try {
    const content = await fs.readFile(dataFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { mails: [], syncState: { processedKeys: [], latestUid: 0 } };
    }
    throw error;
  }
}

async function writeStoredMails(payload) {
  await ensureStorage();
  await fs.writeFile(dataFile, JSON.stringify(payload, null, 2), "utf8");
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
        resolve({ code, stdout, stderr, parsed });
        return;
      }
      reject(new Error(parsed?.error?.message || text || `agently-cli 执行失败，退出码 ${code}`));
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
  if (attachment.content_type || attachment.mime_type || attachment.contentType) {
    summary.push(`MIME: ${attachment.content_type || attachment.mime_type || attachment.contentType}`);
  }
  if (attachment.download_url && !attachment.attachment_id) {
    summary.push("该附件为外链大附件，页面不会自动下载。");
  }
  return summary;
}

async function downloadAgentAttachment(messageId, attachment) {
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

async function normalizeAgentMessage(summaryItem) {
  const messageId = summaryItem.id || summaryItem.message_id || summaryItem.msg_id;
  if (!messageId) {
    return null;
  }

  const messageResult = await runAgently(["message", "+read", "--id", messageId]);
  const fullMessage = pickObjectData(messageResult.parsed);
  const attachments = Array.isArray(fullMessage.attachments) ? fullMessage.attachments : [];

  const normalizedAttachments = [];
  for (const attachment of attachments) {
    const downloaded = await downloadAgentAttachment(messageId, attachment);
    normalizedAttachments.push({
      name: attachment.filename || attachment.name || downloaded?.fileName || "附件",
      type: attachment.content_type || attachment.mime_type || "附件",
      size: Number(attachment.size) || 0,
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
    messageId,
    uid: "",
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
    textBody: fullMessage.text || bodyLines.join("\n"),
    htmlBody: fullMessage.html || "",
    attachments: normalizedAttachments
  };
}

async function importAgentInbox(config, options = {}) {
  await ensureStorage();

  const alias = String(options.alias || config.agent.alias || defaultAgentAlias);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 50);
  let items = [];

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
    const normalized = await normalizeAgentMessage(item);
    if (normalized) {
      mails.push(normalized);
    }
  }

  const payload = {
    mode: "agent",
    alias,
    importedAt: new Date().toISOString(),
    mails,
    syncState: {
      latestUid: 0,
      processedKeys: mails.map((mail) => mail.messageId || mail.id)
    },
    syncLog: {
      scanned: items.length,
      added: mails.length,
      skipped: 0
    }
  };

  await writeStoredMails(payload);
  return payload;
}

class LineSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    socket.on("error", (error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      this.fail(new Error("邮件服务器连接已关闭"));
    });
  }

  fail(error) {
    while (this.waiters.length) {
      this.waiters.shift().reject(error);
    }
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      waiter.tryResolve();
    }
  }

  readLine() {
    return new Promise((resolve, reject) => {
      const waiter = {
        reject,
        tryResolve: () => {
          const index = this.buffer.indexOf("\r\n");
          if (index === -1) {
            return;
          }
          const line = this.buffer.slice(0, index).toString("utf8");
          this.buffer = this.buffer.slice(index + 2);
          this.waiters = this.waiters.filter((item) => item !== waiter);
          resolve(line);
        }
      };
      this.waiters.push(waiter);
      waiter.tryResolve();
    });
  }

  readBytes(length) {
    return new Promise((resolve, reject) => {
      const waiter = {
        reject,
        tryResolve: () => {
          if (this.buffer.length < length) {
            return;
          }
          const bytes = this.buffer.slice(0, length);
          this.buffer = this.buffer.slice(length);
          this.waiters = this.waiters.filter((item) => item !== waiter);
          resolve(bytes);
        }
      };
      this.waiters.push(waiter);
      waiter.tryResolve();
    });
  }

  write(text) {
    this.socket.write(text);
  }

  end() {
    this.socket.end();
  }
}

class ImapClient {
  constructor(config) {
    this.config = config;
    this.tagCounter = 1;
    this.lineSocket = null;
  }

  async connect() {
    const socket = this.config.secure
      ? tls.connect({
          host: this.config.host,
          port: this.config.port,
          servername: this.config.host
        })
      : net.connect({
          host: this.config.host,
          port: this.config.port
        });

    socket.setTimeout(this.config.timeoutMs || 30000, () => {
      socket.destroy(new ImapTimeoutError());
    });
    this.lineSocket = new LineSocket(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });

    const greeting = await this.lineSocket.readLine();
    if (!/^\* OK/i.test(greeting)) {
      throw new ImapConfigError("IMAP 配置错误或服务器无响应");
    }
  }

  nextTag() {
    const tag = `A${String(this.tagCounter).padStart(4, "0")}`;
    this.tagCounter += 1;
    return tag;
  }

  async command(commandText, allowNo = false) {
    const tag = this.nextTag();
    this.lineSocket.write(`${tag} ${commandText}\r\n`);
    const items = [];

    while (true) {
      const line = await this.lineSocket.readLine();
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const literal = await this.lineSocket.readBytes(Number(literalMatch[1]));
        items.push({ line, literal: literal.toString("binary") });
        continue;
      }

      items.push({ line });
      if (line.startsWith(tag)) {
        if (!new RegExp(`^${tag} (OK|${allowNo ? "NO|" : ""})`, "i").test(line)) {
          if (/AUTH|LOGIN|AUTHENTICATION|Invalid credentials|Username and Password/i.test(line)) {
            throw new ImapAuthError();
          }
          throw new ImapConfigError("IMAP 配置错误或服务器返回失败");
        }
        return items;
      }
    }
  }

  async login() {
    try {
      await this.command(`LOGIN ${imapQuote(this.config.email)} ${imapQuote(this.config.authCode)}`);
    } catch (error) {
      if (error instanceof ImapTimeoutError) {
        throw error;
      }
      throw new ImapAuthError();
    }
  }

  async selectMailbox() {
    await this.command(`SELECT ${imapQuote(this.config.mailbox || "INBOX")}`);
  }

  async searchUids(sinceDate) {
    const response = await this.command(`UID SEARCH SINCE ${formatImapDate(sinceDate)}`);
    const searchLine = response.find((item) => item.line.startsWith("* SEARCH"))?.line || "";
    return searchLine
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/)
      .map((uid) => Number(uid))
      .filter(Boolean);
  }

  async fetchMessages(uids) {
    if (!uids.length) {
      return [];
    }
    const candidateLimit = Math.min(Math.max(this.config.limit * 4, this.config.limit), 200);
    const limited = uids.slice(-candidateLimit);
    const set = limited.join(",");
    const response = await this.command(`UID FETCH ${set} (UID BODY.PEEK[])`);
    return response
      .filter((item) => item.literal)
      .map((item) => ({
        uid: Number(item.line.match(/\bUID\s+(\d+)/i)?.[1] || 0),
        raw: item.literal
      }))
      .filter((item) => item.uid);
  }

  async logout() {
    try {
      await this.command("LOGOUT", true);
    } catch {
      // The socket can close immediately after LOGOUT on some servers.
    }
    this.lineSocket?.end();
  }
}

function imapQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function formatImapDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function splitHeadersAndBody(raw) {
  const normalized = String(raw || "").replace(/\r\n/g, "\n");
  const index = normalized.indexOf("\n\n");
  if (index === -1) {
    return { headersText: normalized, body: "" };
  }
  return {
    headersText: normalized.slice(0, index),
    body: normalized.slice(index + 2)
  };
}

function parseHeaders(headersText) {
  const headers = {};
  let currentKey = "";
  for (const line of headersText.split("\n")) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ` ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    currentKey = line.slice(0, index).toLowerCase();
    headers[currentKey] = line.slice(index + 1).trim();
  }
  return headers;
}

function decodeMimeWord(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset, encoding, text) => {
    try {
      const binary =
        encoding.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
      return new TextDecoder(charset.toLowerCase()).decode(binary);
    } catch {
      return text;
    }
  });
}

function parseHeaderParams(value = "") {
  const [main, ...params] = String(value).split(";");
  const parsed = { value: main.trim().toLowerCase() };
  for (const param of params) {
    const index = param.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = param.slice(0, index).trim().toLowerCase().replace(/\*$/, "");
    parsed[key] = decodeMimeWord(param.slice(index + 1).trim().replace(/^"|"$/g, ""));
  }
  return parsed;
}

function normalizeCharset(charset) {
  const value = String(charset || "utf-8").trim().toLowerCase();
  if (value === "gb2312" || value === "gbk" || value === "cp936") {
    return "gb18030";
  }
  return value || "utf-8";
}

function decodeTextBuffer(buffer, charset) {
  const replacementCount = (value) => (value.match(/\uFFFD/g) || []).length;
  const declaredCharset = normalizeCharset(charset);

  try {
    const decoded = new TextDecoder(declaredCharset).decode(buffer);
    if (replacementCount(decoded) === 0) {
      return decoded;
    }

    const gbDecoded = new TextDecoder("gb18030").decode(buffer);
    return replacementCount(gbDecoded) < replacementCount(decoded) ? gbDecoded : decoded;
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return new TextDecoder("utf-8").decode(buffer);
    }
  }
}

function detectBodyCharset(body) {
  const ascii = String(body || "");
  return (
    ascii.match(/<meta[^>]+charset=["']?\s*([^"'>\s;]+)/i)?.[1] ||
    ascii.match(/charset=["']?\s*([^"'>\s;]+)/i)?.[1] ||
    ""
  );
}

function decodeTransferBody(body, encoding, charset) {
  return decodeTextBuffer(decodeTransferBuffer(body, encoding), charset || detectBodyCharset(String(body || "")));
}

function decodeTransferBuffer(body, encoding) {
  const normalized = String(body || "");
  switch (String(encoding || "").toLowerCase()) {
    case "base64":
      return Buffer.from(normalized.replace(/\s/g, ""), "base64");
    case "quoted-printable":
      return Buffer.from(
        normalized.replace(/=\n/g, "").replace(/=([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
        "binary"
      );
    default:
      return Buffer.from(normalized, "binary");
  }
}

function splitMultipart(body, boundary) {
  if (!boundary) {
    return [];
  }
  const marker = `--${boundary}`;
  return String(body)
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^\n/, "").replace(/\n--\s*$/, ""))
    .filter((part) => part.trim() && !part.trim().startsWith("--"));
}

function extractFilename(disposition, contentType) {
  return disposition.filename || contentType.name || "";
}

function parseMimeEntity(raw) {
  const { headersText, body } = splitHeadersAndBody(raw);
  const headers = parseHeaders(headersText);
  const contentType = parseHeaderParams(headers["content-type"] || "text/plain");
  const disposition = parseHeaderParams(headers["content-disposition"] || "");

  if (contentType.value.startsWith("multipart/")) {
    const parts = splitMultipart(body, contentType.boundary);
    return parts.map(parseMimeEntity).reduce(
      (acc, item) => ({
        text: [acc.text, item.text].filter(Boolean).join("\n"),
        html: [acc.html, item.html].filter(Boolean).join("\n"),
        attachments: [...acc.attachments, ...item.attachments]
      }),
      { text: "", html: "", attachments: [] }
    );
  }

  const filename = extractFilename(disposition, contentType);
  const decodedBody = decodeTransferBody(body, headers["content-transfer-encoding"], contentType.charset);
  const isAttachment = disposition.value === "attachment" || Boolean(filename);

  if (isAttachment) {
    const content = decodeTransferBuffer(body, headers["content-transfer-encoding"]);
    return {
      text: "",
      html: "",
      attachments: [
        {
          name: filename || "附件",
          type: contentType.value || "application/octet-stream",
          size: content.length,
          content
        }
      ]
    };
  }

  if (contentType.value === "text/html") {
    return { text: "", html: decodedBody, attachments: [] };
  }

  return { text: decodedBody, html: "", attachments: [] };
}

function safeFileName(fileName) {
  return String(fileName || "attachment")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+$/, "attachment")
    .slice(0, 180);
}

async function saveImapAttachment(mailId, index, attachment) {
  if (!attachment.content?.length) {
    return null;
  }

  const safeMailId = safeFileName(mailId || "message");
  const targetDir = path.join(attachmentDir, safeMailId);
  await fs.mkdir(targetDir, { recursive: true });

  const fileName = safeFileName(attachment.name || `attachment-${index + 1}`);
  const targetPath = path.join(targetDir, fileName);
  await fs.writeFile(targetPath, attachment.content);

  return {
    fileName,
    webPath: `/attachments/${encodeURIComponent(safeMailId)}/${encodeURIComponent(fileName)}`
  };
}

async function normalizeImapMessage(item, accountEmail) {
  const { headersText } = splitHeadersAndBody(item.raw);
  const headers = parseHeaders(headersText);
  const parsed = parseMimeEntity(item.raw);
  const messageId = decodeMimeWord(headers["message-id"] || "");
  const id = messageId || `uid:${item.uid}`;
  const htmlTextLines = stripHtml(parsed.html);
  const plainTextLines = splitPlainText(parsed.text);
  const textLines = hasReplacementText(plainTextLines.join("\n")) && htmlTextLines.length
    ? htmlTextLines
    : plainTextLines.length
      ? plainTextLines
      : htmlTextLines;
  const attachments = [];
  for (const [index, attachment] of parsed.attachments.entries()) {
    const saved = await saveImapAttachment(id, index, attachment);
    attachments.push({
      name: saved?.fileName || attachment.name || "附件",
      type: attachment.type || "附件",
      size: Number(attachment.size) || 0,
      previewPath: saved?.webPath || "",
      previewMode: detectPreviewMode(saved?.fileName || attachment.name, attachment.type),
      previewLabel: saved ? "点击打开已下载附件" : "IMAP 已读取附件元数据，暂未下载附件内容",
      summary: summarizeAttachment(attachment),
      downloadUrl: ""
    });
  }

  return {
    id,
    messageId,
    uid: item.uid,
    subject: decodeMimeWord(headers.subject || "(无主题)"),
    sender: decodeMimeWord(headers.from || "未知"),
    recipients: decodeMimeWord(headers.to || accountEmail || "未知"),
    time: headers.date || "",
    listEmail: decodeMimeWord(headers.from || ""),
    body: textLines.length ? textLines : ["(无正文)"],
    textBody: hasReplacementText(parsed.text) && htmlTextLines.length ? htmlTextLines.join("\n") : parsed.text || textLines.join("\n"),
    htmlBody: parsed.html || "",
    attachments: attachments.length
      ? attachments
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

function getDedupKey(mail) {
  if (mail.messageId) {
    return `message:${normalizeDedupPart(mail.messageId)}`;
  }
  if (mail.uid) {
    return `uid:${mail.uid}`;
  }
  return `meta:${normalizeDedupPart(mail.subject)}|${normalizeDedupPart(mail.sender)}|${normalizeDedupPart(mail.time)}`;
}

export function countRetainedAddedMails(retainedMails, previousKeys) {
  const knownKeys = previousKeys instanceof Set ? previousKeys : new Set(previousKeys || []);
  return retainedMails.reduce(
    (count, mail) => count + (knownKeys.has(getDedupKey(mail)) ? 0 : 1),
    0
  );
}

function normalizeDedupPart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getMailTime(mail) {
  const timestamp = new Date(mail.time || "").getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isMailWithinDays(mail, days) {
  const timestamp = getMailTime(mail);
  if (!timestamp) {
    return false;
  }
  return timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function hasReplacementChars(mail) {
  const text = [
    mail.subject,
    mail.sender,
    mail.recipients,
    mail.textBody,
    mail.htmlBody,
    ...(Array.isArray(mail.body) ? mail.body : [])
  ].join("\n");
  return text.includes("\uFFFD");
}

function hasReplacementText(value) {
  return String(value || "").includes("\uFFFD");
}

async function syncImapInbox(config, options = {}) {
  assertImapConfig(config);
  await ensureStorage();

  const syncLimit = Math.min(Math.max(Number(options.limit) || config.imap.limit, 1), 200);
  const syncDays = config.imap.days;
  const stored = await readStoredMails();
  let previousMails = (Array.isArray(stored.mails) ? stored.mails : []).filter((mail) => isMailWithinDays(mail, syncDays));
  const previousByKey = new Map(previousMails.map((mail) => [getDedupKey(mail), mail]).filter(([key]) => key));
  const previousKeysBeforeSync = new Set(previousByKey.keys());
  const processedKeys = new Set([
    ...(Array.isArray(stored.syncState?.processedKeys) ? stored.syncState.processedKeys : []),
    ...previousMails.map(getDedupKey).filter(Boolean)
  ]);
  const latestUid = Math.max(Number(stored.syncState?.latestUid) || 0, ...previousMails.map((mail) => Number(mail.uid) || 0));
  const client = new ImapClient({ ...config.imap, limit: syncLimit });

  let fetched = [];
  try {
    await client.connect();
    await client.login();
    await client.selectMailbox();
    const sinceDate = new Date(Date.now() - syncDays * 24 * 60 * 60 * 1000);
    const uids = await client.searchUids(sinceDate);
    fetched = await client.fetchMessages(uids);
  } catch (error) {
    if (error instanceof ImapAuthError) {
      throw new Error("IMAP 认证失败，请检查邮箱授权码");
    }
    if (error instanceof ImapTimeoutError) {
      throw new Error("IMAP 连接超时，请检查服务器地址和网络");
    }
    if (error instanceof ImapConfigError) {
      throw new Error("IMAP 配置错误，请检查服务器、端口和 SSL 设置");
    }
    throw new Error("IMAP 同步失败，请检查邮箱配置");
  } finally {
    await client.logout().catch(() => {});
  }

  const newMails = [];
  const queuedKeys = new Set();
  let skipped = 0;
  let skippedOld = 0;
  let replaced = 0;
  let nextLatestUid = latestUid;

  for (const item of fetched) {
    const mail = await normalizeImapMessage(item, config.imap.email);
    const key = getDedupKey(mail);
    nextLatestUid = Math.max(nextLatestUid, Number(mail.uid) || 0);
    if (!isMailWithinDays(mail, syncDays)) {
      skippedOld += 1;
      continue;
    }
    if (queuedKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const previous = previousByKey.get(key);
    if (previous) {
      if (options.force || (hasReplacementChars(previous) && !hasReplacementChars(mail))) {
        previousMails = previousMails.filter((item) => getDedupKey(item) !== key);
        previousByKey.delete(key);
        queuedKeys.add(key);
        newMails.push(mail);
        replaced += 1;
        continue;
      }
      skipped += 1;
      continue;
    }
    processedKeys.add(key);
    queuedKeys.add(key);
    newMails.push(mail);
  }

  const mails = [...newMails, ...previousMails]
    .sort((left, right) => getMailTime(right) - getMailTime(left))
    .slice(0, syncLimit);
  const detected = newMails.length - replaced;
  const added = countRetainedAddedMails(mails, previousKeysBeforeSync);
  const payload = {
    mode: "imap_smtp",
    alias: config.imap.email,
    importedAt: new Date().toISOString(),
    mails,
    syncState: {
      latestUid: nextLatestUid,
      lastSyncAt: new Date().toISOString(),
      processedKeys: Array.from(processedKeys).slice(-1000)
    },
    syncLog: {
      scanned: fetched.length,
      detected,
      added,
      replaced,
      skipped,
      skippedOld
    }
  };

  await writeStoredMails(payload);
  console.log(`IMAP sync complete: scanned=${fetched.length}, detected=${detected}, retained=${mails.length}, added=${added}, replaced=${replaced}, skipped=${skipped}, skippedOld=${skippedOld}`);
  return payload;
}

async function readSmtpLine(lineSocket) {
  const lines = [];
  while (true) {
    const line = await lineSocket.readLine();
    lines.push(line);
    if (!/^\d{3}-/.test(line)) {
      return lines;
    }
  }
}

async function expectSmtp(lineSocket, codes) {
  const lines = await readSmtpLine(lineSocket);
  const code = Number(lines.at(-1)?.slice(0, 3));
  if (!codes.includes(code)) {
    throw new Error("SMTP 配置错误或认证失败");
  }
  return lines;
}

async function smtpCommand(lineSocket, command, codes) {
  lineSocket.write(`${command}\r\n`);
  return expectSmtp(lineSocket, codes);
}

function encodeMailSubject(subject) {
  return /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
}

export async function sendSmtpMail(message) {
  const config = getMailConfig();
  assertSmtpConfig(config);

  const recipients = Array.isArray(message.to) ? message.to : String(message.to || "").split(",");
  const cleanRecipients = recipients.map((item) => item.trim()).filter(Boolean);
  if (!cleanRecipients.length) {
    throw new Error("请提供收件人");
  }

  const socket = config.smtp.secure
    ? tls.connect({
        host: config.smtp.host,
        port: config.smtp.port,
        servername: config.smtp.host
      })
    : net.connect({
        host: config.smtp.host,
        port: config.smtp.port
      });
  const lineSocket = new LineSocket(socket);

  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    await expectSmtp(lineSocket, [220]);
    await smtpCommand(lineSocket, "EHLO localhost", [250]);
    await smtpCommand(lineSocket, "AUTH LOGIN", [334]);
    await smtpCommand(lineSocket, Buffer.from(config.smtp.email).toString("base64"), [334]);
    await smtpCommand(lineSocket, Buffer.from(config.smtp.authCode).toString("base64"), [235]);
    await smtpCommand(lineSocket, `MAIL FROM:<${config.smtp.email}>`, [250]);
    for (const recipient of cleanRecipients) {
      await smtpCommand(lineSocket, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await smtpCommand(lineSocket, "DATA", [354]);

    const subject = encodeMailSubject(String(message.subject || "(无主题)"));
    const text = String(message.text || message.body || "");
    const body = [
      `From: <${config.smtp.email}>`,
      `To: ${cleanRecipients.join(", ")}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text.replace(/\r?\n\./g, "\n.."),
      "."
    ].join("\r\n");

    lineSocket.write(`${body}\r\n`);
    await expectSmtp(lineSocket, [250]);
    await smtpCommand(lineSocket, "QUIT", [221]);
    return { ok: true, from: config.smtp.email, to: cleanRecipients };
  } catch {
    throw new Error("SMTP 发送失败，请检查邮箱配置或授权码");
  } finally {
    lineSocket.end();
  }
}

export async function importInbox(options = {}) {
  const config = getMailConfig();
  if (config.mode === "imap_smtp") {
    return syncImapInbox(config, options);
  }
  return importAgentInbox(config, options);
}
