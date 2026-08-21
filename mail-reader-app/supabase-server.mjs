import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const credentialKeyBytes = 32;
let serviceClient;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`缺少部署环境变量 ${name}`);
  }
  return value;
}

export function getSupabaseUrl() {
  return requireEnvironment("SUPABASE_URL");
}

export function getSupabasePublishableKey() {
  return requireEnvironment("SUPABASE_PUBLISHABLE_KEY");
}

export function getSupabaseServiceClient() {
  if (!serviceClient) {
    const serviceKey = String(
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    ).trim();
    if (!serviceKey) {
      throw new Error("缺少部署环境变量 SUPABASE_SECRET_KEY");
    }
    serviceClient = createClient(getSupabaseUrl(), serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return serviceClient;
}

export async function getAuthenticatedUser(request) {
  const authorization = String(request.headers.authorization || "");
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    throw new HttpError(401, "请先登录后再使用邮箱服务");
  }

  const { data, error } = await getSupabaseServiceClient().auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, "登录已失效，请重新登录");
  }
  return data.user;
}

export function createWorkspaceToken(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(normalizedUserId)) {
    throw new Error("云端工作区标识无效");
  }
  const signature = createHmac("sha256", getCredentialKey())
    .update(`orderbridge-workspace:${normalizedUserId}`)
    .digest("base64url");
  return `obw.${normalizedUserId}.${signature}`;
}

export function getWorkspaceUserId(token) {
  const match = String(token || "").match(/^obw\.([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i);
  if (!match) return "";
  const [, userId, signature] = match;
  const expected = createWorkspaceToken(userId).split(".")[2];
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? userId
    : "";
}

function getCredentialKey() {
  const encoded = requireEnvironment("CREDENTIAL_ENCRYPTION_KEY");
  const key = /^[a-f0-9]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== credentialKeyBytes) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值");
  }
  return key;
}

export function encryptCredential(value) {
  const plaintext = String(value || "").trim();
  if (!plaintext) {
    throw new Error("凭据不能为空");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getCredentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptCredential({ ciphertext, iv, tag }) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", getCredentialKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("无法解密已保存的凭据，请重新填写后保存");
  }
}

export function assertSupabase(result, fallbackMessage = "Supabase 请求失败") {
  if (result?.error) {
    throw new Error(result.error.message || fallbackMessage);
  }
  return result?.data;
}

export function toIsoDate(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
