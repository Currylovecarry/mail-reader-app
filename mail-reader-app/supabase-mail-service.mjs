import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ImapClient,
  countRetainedAddedMails,
  getDedupKey,
  getMailTime,
  isMailWithinDays,
  normalizeImapMessage,
  sendSmtpMail
} from "./mail-service.mjs";
import { getUserMailboxRuntimeConfig } from "./supabase-config-service.mjs";
import { assertSupabase, getSupabaseServiceClient, toIsoDate } from "./supabase-server.mjs";

const attachmentBucket = "mail-attachments";

function emptyMailStore() {
  return { mails: [], syncState: { processedKeys: [], latestUid: 0, lastSyncAt: "" } };
}

function safeFileName(fileName) {
  return String(fileName || "attachment")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+$/, "attachment")
    .slice(0, 180);
}

function hasReplacementChars(mail) {
  return [
    mail.subject,
    mail.sender,
    mail.recipients,
    mail.textBody,
    mail.htmlBody,
    ...(Array.isArray(mail.body) ? mail.body : [])
  ].join("\n").includes("\uFFFD");
}

function storageObjectPath(userId, mailId, index, name) {
  const mailHash = createHash("sha256").update(String(mailId)).digest("hex").slice(0, 32);
  return `${userId}/${mailHash}/${index + 1}-${safeFileName(name)}`;
}

async function uploadAttachment(userId, mailId, index, attachment) {
  if (!attachment?.content?.length) return null;
  const objectPath = storageObjectPath(userId, mailId, index, attachment.name);
  const supabase = getSupabaseServiceClient();
  assertSupabase(await supabase.storage.from(attachmentBucket).upload(objectPath, attachment.content, {
    contentType: attachment.type || "application/octet-stream",
    upsert: true
  }));
  return { fileName: safeFileName(attachment.name), storagePath: objectPath, webPath: "" };
}

async function hydrateMailAttachments(mail) {
  const attachments = Array.isArray(mail.attachments) ? mail.attachments : [];
  const storedPaths = attachments.map((item) => item.storagePath).filter(Boolean);
  if (!storedPaths.length) return mail;

  const supabase = getSupabaseServiceClient();
  const signed = await Promise.all(storedPaths.map(async (objectPath) => {
    const result = await supabase.storage.from(attachmentBucket).createSignedUrl(objectPath, 60 * 60);
    return [objectPath, assertSupabase(result)?.signedUrl || ""];
  }));
  const signedUrls = new Map(signed);
  return {
    ...mail,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      previewPath: attachment.storagePath ? signedUrls.get(attachment.storagePath) || "" : attachment.previewPath || ""
    }))
  };
}

async function listRawMails(userId) {
  const supabase = getSupabaseServiceClient();
  const result = await supabase
    .from("mail_messages")
    .select("external_id, payload")
    .eq("user_id", userId)
    .order("message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false });
  const records = assertSupabase(result) || [];
  return records.map((record) => ({ ...record.payload, id: record.external_id }));
}

export async function readUserStoredMails(userId) {
  const supabase = getSupabaseServiceClient();
  const [mails, state] = await Promise.all([
    listRawMails(userId),
    supabase.from("mail_sync_states").select("*").eq("user_id", userId).maybeSingle()
  ]);
  assertSupabase(state);
  return {
    mode: state.data?.mode || "imap_smtp",
    alias: state.data?.alias || "",
    importedAt: state.data?.imported_at || "",
    mails: await Promise.all(mails.map(hydrateMailAttachments)),
    syncState: state.data?.sync_state || emptyMailStore().syncState,
    syncLog: state.data?.sync_log || {}
  };
}

async function writeUserStoredMails(userId, payload) {
  const supabase = getSupabaseServiceClient();
  const mails = Array.isArray(payload.mails) ? payload.mails : [];
  const existing = await supabase.from("mail_messages").select("external_id").eq("user_id", userId);
  const existingIds = new Set((assertSupabase(existing) || []).map((record) => record.external_id));
  const mailIds = new Set(mails.map((mail) => String(mail.id)));
  const rows = mails.map((mail) => ({
    user_id: userId,
    external_id: String(mail.id),
    message_id: String(mail.messageId || ""),
    uid: String(mail.uid || ""),
    message_at: toIsoDate(mail.time),
    payload: { ...mail, id: String(mail.id) },
    updated_at: new Date().toISOString()
  }));
  if (rows.length) {
    assertSupabase(await supabase.from("mail_messages").upsert(rows, {
      onConflict: "user_id,external_id"
    }));
  }
  const removedIds = [...existingIds].filter((id) => !mailIds.has(id));
  if (removedIds.length) {
    assertSupabase(await supabase.from("mail_messages")
      .delete()
      .eq("user_id", userId)
      .in("external_id", removedIds));
  }
  assertSupabase(await supabase.from("mail_sync_states").upsert({
    user_id: userId,
    mode: payload.mode || "imap_smtp",
    alias: payload.alias || "",
    sync_state: payload.syncState || {},
    sync_log: payload.syncLog || {},
    imported_at: payload.importedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" }));
}

export async function clearUserImportedMailCache(userId) {
  const supabase = getSupabaseServiceClient();
  assertSupabase(await supabase.from("mail_messages").delete().eq("user_id", userId));
  await writeUserStoredMails(userId, emptyMailStore());
}

export async function findUserMail(userId, emailId, { hydrate = false } = {}) {
  const result = await getSupabaseServiceClient()
    .from("mail_messages")
    .select("external_id, payload")
    .eq("user_id", userId)
    .eq("external_id", String(emailId || ""))
    .maybeSingle();
  assertSupabase(result);
  if (!result.data) return null;
  const mail = { ...result.data.payload, id: result.data.external_id };
  return hydrate ? hydrateMailAttachments(mail) : mail;
}

export async function withMaterializedAttachments(userId, mail, callback) {
  const temporaryDirectory = path.join(os.tmpdir(), "orderbridge", userId, randomUUID());
  const attachments = Array.isArray(mail.attachments) ? mail.attachments : [];
  try {
    await fs.mkdir(temporaryDirectory, { recursive: true });
    const preparedAttachments = await Promise.all(attachments.map(async (attachment, index) => {
      if (!attachment.storagePath) return attachment;
      const downloaded = await getSupabaseServiceClient().storage
        .from(attachmentBucket)
        .download(attachment.storagePath);
      const blob = assertSupabase(downloaded);
      const filePath = path.join(temporaryDirectory, `${index + 1}-${safeFileName(attachment.name)}`);
      await fs.writeFile(filePath, Buffer.from(await blob.arrayBuffer()));
      return { ...attachment, filePath };
    }));
    return await callback({ ...mail, attachments: preparedAttachments });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function importUserInbox(userId, options = {}) {
  const config = await getUserMailboxRuntimeConfig(userId);
  const syncLimit = Math.min(Math.max(Number(options.limit) || config.imap.limit, 1), 200);
  const syncDays = config.imap.days;
  const stored = await readUserStoredMails(userId);
  let previousMails = (stored.mails || []).filter((mail) => isMailWithinDays(mail, syncDays));
  const previousByKey = new Map(previousMails.map((mail) => [getDedupKey(mail), mail]).filter(([key]) => key));
  const previousKeysBeforeSync = new Set(previousByKey.keys());
  const processedKeys = new Set([
    ...(Array.isArray(stored.syncState?.processedKeys) ? stored.syncState.processedKeys : []),
    ...previousMails.map(getDedupKey).filter(Boolean)
  ]);
  const latestUid = Math.max(
    Number(stored.syncState?.latestUid) || 0,
    ...previousMails.map((mail) => Number(mail.uid) || 0)
  );
  const client = new ImapClient({ ...config.imap, limit: syncLimit });
  let fetched = [];
  try {
    await client.connect();
    await client.login();
    await client.identify();
    await client.selectMailbox();
    const sinceDate = new Date(Date.now() - syncDays * 24 * 60 * 60 * 1000);
    fetched = await client.fetchMessages(await client.searchUids(sinceDate));
  } catch (error) {
    const message = String(error?.message || "");
    if (/认证|AUTH|LOGIN/i.test(message)) throw new Error("IMAP 认证失败，请检查邮箱授权码");
    if (/超时|timeout/i.test(message)) throw new Error("IMAP 连接超时，请检查服务器地址和网络");
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
    const mail = await normalizeImapMessage(item, config.imap.email, {
      saveAttachment: (mailId, index, attachment) => uploadAttachment(userId, mailId, index, attachment)
    });
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
        previousMails = previousMails.filter((candidate) => getDedupKey(candidate) !== key);
        previousByKey.delete(key);
        queuedKeys.add(key);
        newMails.push(mail);
        replaced += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    processedKeys.add(key);
    queuedKeys.add(key);
    newMails.push(mail);
  }
  const mails = [...newMails, ...previousMails]
    .sort((left, right) => getMailTime(right) - getMailTime(left))
    .slice(0, syncLimit);
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
      detected: newMails.length - replaced,
      added: countRetainedAddedMails(mails, previousKeysBeforeSync),
      replaced,
      skipped,
      skippedOld
    }
  };
  await writeUserStoredMails(userId, payload);
  return { ...payload, mails: await Promise.all(mails.map(hydrateMailAttachments)) };
}

export async function sendUserSmtpMail(userId, message) {
  const config = await getUserMailboxRuntimeConfig(userId);
  return sendSmtpMail(message, { config });
}
