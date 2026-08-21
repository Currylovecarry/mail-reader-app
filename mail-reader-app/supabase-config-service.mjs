import { getPublicMailConfig, normalizeMailboxConfig } from "./mail-service.mjs";
import {
  assertSupabase,
  decryptCredential,
  encryptCredential,
  getSupabaseServiceClient
} from "./supabase-server.mjs";

function cleanText(value, { maxLength = 255 } = {}) {
  const text = String(value || "").trim();
  if (text.length > maxLength || /[\r\n]/.test(text)) {
    throw new Error("配置格式不正确");
  }
  return text;
}

function normalizeBaseUrl(value) {
  const baseUrl = cleanText(value || "https://api.deepseek.com", { maxLength: 500 })
    .replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("DeepSeek API 地址格式不正确");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("DeepSeek API 地址必须使用 HTTPS");
  }
  return baseUrl;
}

function publicLlmConfig(row) {
  return {
    provider: "deepseek",
    base_url: row?.base_url || "https://api.deepseek.com",
    model: row?.model || "deepseek-v4-flash",
    configured: Boolean(row?.api_key_ciphertext)
  };
}

function mapMailboxRow(row) {
  if (!row) return null;
  return {
    mode: "imap_smtp",
    imap: {
      email: row.email,
      host: row.imap_host,
      port: row.imap_port,
      secure: row.imap_secure,
      mailbox: row.imap_mailbox,
      limit: 50,
      days: 3650,
      timeoutMs: 30_000,
      authCode: decryptCredential({
        ciphertext: row.auth_code_ciphertext,
        iv: row.auth_code_iv,
        tag: row.auth_code_tag
      })
    },
    smtp: {
      email: row.email,
      host: row.smtp_host,
      port: row.smtp_port,
      secure: row.smtp_secure,
      authCode: decryptCredential({
        ciphertext: row.auth_code_ciphertext,
        iv: row.auth_code_iv,
        tag: row.auth_code_tag
      })
    },
    agent: { alias: "" }
  };
}

function publicMailboxConfig(row) {
  if (!row) {
    return {
      mode: "imap_smtp",
      email: "",
      imap: { host: "", port: 993, secure: true, mailbox: "INBOX", limit: 50, days: 3650, configured: false },
      smtp: { host: "", port: 465, secure: true, configured: false },
      agent: { alias: "" }
    };
  }
  return getPublicMailConfig(mapMailboxRow(row));
}

async function getRows(userId) {
  const supabase = getSupabaseServiceClient();
  const [mailbox, llm] = await Promise.all([
    supabase.from("mailbox_connections").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("llm_connections").select("*").eq("user_id", userId).maybeSingle()
  ]);
  assertSupabase(mailbox);
  assertSupabase(llm);
  return { mailbox: mailbox.data, llm: llm.data };
}

export async function getUserConfiguration(userId) {
  const { mailbox, llm } = await getRows(userId);
  return { ...publicMailboxConfig(mailbox), llm: publicLlmConfig(llm) };
}

export async function getUserMailboxRuntimeConfig(userId) {
  const { mailbox } = await getRows(userId);
  if (!mailbox) {
    throw new Error("请先填写并保存邮箱连接信息");
  }
  return mapMailboxRow(mailbox);
}

export async function getUserLlmRuntimeConfig(userId) {
  const { llm } = await getRows(userId);
  if (!llm?.api_key_ciphertext) {
    throw new Error("请先填写并保存 DeepSeek API Key");
  }
  return {
    baseUrl: llm.base_url,
    model: llm.model,
    apiKey: decryptCredential({
      ciphertext: llm.api_key_ciphertext,
      iv: llm.api_key_iv,
      tag: llm.api_key_tag
    })
  };
}

export async function saveUserConfiguration(userId, input = {}) {
  const { mailbox: existingMailbox, llm: existingLlm } = await getRows(userId);
  const suppliedAuthCode = String(input.authCode || "").trim();
  const retainedAuthCode = existingMailbox
    ? decryptCredential({
        ciphertext: existingMailbox.auth_code_ciphertext,
        iv: existingMailbox.auth_code_iv,
        tag: existingMailbox.auth_code_tag
      })
    : "";
  const mailbox = normalizeMailboxConfig({ ...input, authCode: suppliedAuthCode || retainedAuthCode });
  const authCredential = encryptCredential(suppliedAuthCode || retainedAuthCode);
  const suppliedApiKey = String(input.llmApiKey || "").trim();
  const retainedApiKey = existingLlm?.api_key_ciphertext
    ? decryptCredential({
        ciphertext: existingLlm.api_key_ciphertext,
        iv: existingLlm.api_key_iv,
        tag: existingLlm.api_key_tag
      })
    : "";
  const apiKey = suppliedApiKey || retainedApiKey;
  const supabase = getSupabaseServiceClient();
  const now = new Date().toISOString();

  assertSupabase(await supabase.from("mailbox_connections").upsert({
    user_id: userId,
    email: mailbox.MAIL_EMAIL,
    imap_host: mailbox.IMAP_HOST,
    imap_port: Number(mailbox.IMAP_PORT),
    imap_secure: mailbox.IMAP_SECURE === "true",
    imap_mailbox: mailbox.IMAP_MAILBOX,
    smtp_host: mailbox.SMTP_HOST,
    smtp_port: Number(mailbox.SMTP_PORT),
    smtp_secure: mailbox.SMTP_SECURE === "true",
    auth_code_ciphertext: authCredential.ciphertext,
    auth_code_iv: authCredential.iv,
    auth_code_tag: authCredential.tag,
    updated_at: now
  }, { onConflict: "user_id" }));

  if (apiKey) {
    const apiCredential = encryptCredential(apiKey);
    assertSupabase(await supabase.from("llm_connections").upsert({
      user_id: userId,
      provider: "deepseek",
      base_url: normalizeBaseUrl(input.llmBaseUrl || existingLlm?.base_url),
      model: cleanText(input.llmModel || existingLlm?.model || "deepseek-v4-flash", { maxLength: 120 }),
      api_key_ciphertext: apiCredential.ciphertext,
      api_key_iv: apiCredential.iv,
      api_key_tag: apiCredential.tag,
      updated_at: now
    }, { onConflict: "user_id" }));
  }

  return getUserConfiguration(userId);
}
