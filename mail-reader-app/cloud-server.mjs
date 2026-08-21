import { createHash, randomBytes } from "node:crypto";
import { extractEmailContent } from "./content-extractor.mjs";
import { analyzeOrderContent } from "./order-analysis-service.mjs";
import { generateOrderDraft } from "./llm-order-draft-service.mjs";
import { ImapClient, buildImapIdentificationCommand, normalizeMailboxConfig } from "./mail-service.mjs";
import { getUserConfiguration, getUserLlmRuntimeConfig, saveUserConfiguration } from "./supabase-config-service.mjs";
import {
  clearUserImportedMailCache,
  findUserMail,
  importUserInbox,
  readUserStoredMails,
  sendUserSmtpMail,
  withMaterializedAttachments
} from "./supabase-mail-service.mjs";
import { createSupabaseOrderRecognitionRepository } from "./supabase-order-repository.mjs";
import { createSupabaseProductMatchingService } from "./supabase-product-matching-service.mjs";
import {
  HttpError,
  getAuthenticatedUser,
  getWorkspaceUserId,
  getSupabasePublishableKey,
  getSupabaseServiceClient,
  getSupabaseUrl,
  createWorkspaceToken
} from "./supabase-server.mjs";
import { createSupabaseMailWorkflowRepository } from "./supabase-workflow-repository.mjs";

const orderDraftCache = new Map();
const orderDraftInFlight = new Map();
const maxOrderDraftCacheEntries = 100;
const workspaceAttempts = new Map();
const workspaceWindowMs = 10 * 60 * 1000;
const maxWorkspaceInitializationsPerWindow = 5;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new HttpError(413, "请求内容过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "请求 JSON 格式不正确"));
      }
    });
    request.on("error", reject);
  });
}

function sanitizeError(error) {
  const message = String(error?.message || "服务异常");
  if (/AUTH|LOGIN|password|auth code|授权码/i.test(message)) return "认证失败或邮箱配置错误";
  if (/CREDENTIAL_ENCRYPTION_KEY|SUPABASE_SECRET_KEY/.test(message)) return "服务端尚未完成部署配置";
  return message;
}

function enforceWorkspaceRateLimit(request) {
  const forwardedFor = String(request.headers["x-forwarded-for"] || "");
  const clientKey = forwardedFor.split(",")[0].trim() || String(request.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const recent = (workspaceAttempts.get(clientKey) || []).filter((timestamp) => now - timestamp < workspaceWindowMs);
  if (recent.length >= maxWorkspaceInitializationsPerWindow) {
    throw new HttpError(429, "初始化次数过多，请 10 分钟后再试");
  }
  recent.push(now);
  workspaceAttempts.set(clientKey, recent);
}

function createWorkspaceCredentials() {
  const workspaceId = randomBytes(18).toString("hex");
  return {
    // This is an internal Supabase identity only. It is never shown as, or
    // connected to, the mailbox address entered by the user.
    email: `workspace-${workspaceId}@guest.orderbridge.local`,
    password: randomBytes(32).toString("base64url")
  };
}

async function createGuestWorkspace(request) {
  enforceWorkspaceRateLimit(request);
  const credentials = createWorkspaceCredentials();
  const { data, error } = await getSupabaseServiceClient().auth.admin.createUser({
    email: credentials.email,
    password: credentials.password,
    email_confirm: true,
    user_metadata: { workspace_type: "browser_guest" }
  });
  if (error) {
    throw new HttpError(500, "无法初始化云端工作区，请稍后重试");
  }
  return { workspace_token: createWorkspaceToken(data.user.id) };
}

async function createUserContext(request) {
  const authorization = String(request.headers.authorization || "");
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const workspaceUserId = getWorkspaceUserId(bearerToken);
  const user = workspaceUserId ? { id: workspaceUserId } : await getAuthenticatedUser(request);
  const orderRepository = createSupabaseOrderRecognitionRepository(user.id);
  return {
    user,
    orderRepository,
    productMatchingService: createSupabaseProductMatchingService(user.id, orderRepository),
    workflowRepository: createSupabaseMailWorkflowRepository(user.id)
  };
}

function buildCacheKey(userId, mail, llm) {
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    userId,
    model: llm?.model || "",
    baseUrl: llm?.baseUrl || "",
    mail
  })).digest("hex");
}

async function verifyMailboxAccess(input) {
  const mailbox = normalizeMailboxConfig(input);
  const client = new ImapClient({
    host: mailbox.IMAP_HOST,
    port: Number(mailbox.IMAP_PORT),
    secure: mailbox.IMAP_SECURE === "true",
    email: mailbox.MAIL_EMAIL,
    authCode: mailbox.MAIL_AUTH_CODE,
    mailbox: mailbox.IMAP_MAILBOX,
    timeoutMs: 30_000
  });
  try {
    await client.connect();
    await client.login();
    if (buildImapIdentificationCommand(mailbox.IMAP_HOST)) await client.identify();
    await client.selectMailbox();
  } finally {
    await client.logout().catch(() => {});
  }
}

async function verifyDeepSeekAccess(input = {}) {
  const apiKey = String(input.llmApiKey || "").trim();
  const model = String(input.llmModel || "deepseek-v4-flash").trim();
  const baseUrl = String(input.llmBaseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  if (!apiKey) throw new HttpError(400, "请填写 DeepSeek API Key");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpError(400, "DeepSeek API 地址格式不正确");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "DeepSeek API 地址必须使用 HTTPS");
  }
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new HttpError(400, "DeepSeek API Key 无效、已撤销或没有可用额度");
  }
  if (!response.ok) {
    throw new HttpError(400, payload?.error?.message || `DeepSeek 连接失败（HTTP ${response.status}）`);
  }
  const models = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id || "")) : [];
  if (!models.includes(model)) {
    throw new HttpError(400, `DeepSeek 账号不可用模型：${model}`);
  }
}

function getCachedDraft(cacheKey) {
  const value = orderDraftCache.get(cacheKey);
  if (!value) return null;
  orderDraftCache.delete(cacheKey);
  orderDraftCache.set(cacheKey, value);
  return structuredClone(value);
}

function saveCachedDraft(cacheKey, payload) {
  orderDraftCache.delete(cacheKey);
  orderDraftCache.set(cacheKey, structuredClone(payload));
  while (orderDraftCache.size > maxOrderDraftCacheEntries) {
    orderDraftCache.delete(orderDraftCache.keys().next().value);
  }
}

function isCompleteDeepSeekOrder(payload, matches) {
  const products = payload?.order_draft?.products;
  const summary = matches?.summary || {};
  const totalItems = Number(matches?.total_items) || 0;
  return payload?.status === "success"
    && payload?.provider === "openai_compatible"
    && Array.isArray(products)
    && products.length > 0
    && products.every((product) => String(product?.product_model || "").trim()
      && String(product?.product_name || "").trim()
      && Number(product?.quantity) > 0
      && String(product?.unit || "").trim()
      && Number(product?.confidence) >= 0.8
      && String(product?.evidence?.source || "").trim()
      && String(product?.evidence?.raw_text || "").trim())
    && totalItems === products.length
    && Number(summary.exact_match) === totalItems
    && !Number(summary.fuzzy_match)
    && !Number(summary.no_match)
    && !Number(summary.need_manual_review);
}

function deriveWorkflow(payload, record, matches) {
  if (!['success', 'partial_success'].includes(payload?.status) || !payload?.order_draft) {
    return { status: 'recognition_failed', reason: payload?.error || 'DeepSeek 未返回可用的订单识别结果' };
  }
  if (!record || !matches) {
    return { status: 'manual_review', reason: '订单结果尚未完成保存或产品匹配，需要人工核验' };
  }
  if (isCompleteDeepSeekOrder(payload, matches)) {
    return { status: 'pending_confirmation', reason: 'DeepSeek 识别和产品精确匹配已完成，邮件已核验' };
  }
  return {
    status: 'manual_review',
    reason: payload.provider === 'openai_compatible'
      ? 'DeepSeek 结果不完整或产品匹配存在待核验项'
      : '本地快速识别结果需要 DeepSeek 或人工复核'
  };
}

async function persistWorkflow(context, payload, record, matches) {
  const workflow = deriveWorkflow(payload, record, matches);
  return context.workflowRepository.upsertWorkflow({
    emailId: payload?.email_id,
    status: workflow.status,
    recognitionOrderId: record?.id ?? null,
    recognitionProvider: payload?.provider || '',
    recognitionStatus: payload?.status || '',
    reason: workflow.reason
  });
}

async function generateAndPersistOrderDraft(context, mail) {
  const extracted = await withMaterializedAttachments(context.user.id, mail, extractEmailContent);
  let llmConfig = {};
  try {
    llmConfig = await getUserLlmRuntimeConfig(context.user.id);
  } catch {
    // Structured spreadsheet/table extraction remains available without an LLM key.
  }
  const payload = await generateOrderDraft(extracted, { llmConfig });
  let savedRecord = null;
  let matches = null;
  if (['success', 'partial_success'].includes(payload.status) && payload.order_draft) {
    savedRecord = await context.orderRepository.saveOrderDraft(payload.order_draft);
    payload.persistence = { status: 'saved', result_status: payload.status, recognition_order_id: savedRecord.id };
    try {
      matches = await context.productMatchingService.matchOrderRecognition(savedRecord.id);
      payload.persistence.product_matching = { status: 'matched', summary: matches.summary };
    } catch (error) {
      payload.persistence.product_matching = { status: 'failed', error: sanitizeError(error) };
    }
  }
  payload.workflow = await persistWorkflow(context, payload, savedRecord, matches);
  return payload;
}

function addProcessing(payload, { cacheHit, sharedRequest, durationMs }) {
  return {
    ...payload,
    processing: {
      ...(payload.processing || {}),
      cache_enabled: true,
      cache_hit: cacheHit,
      shared_request: sharedRequest,
      server_duration_ms: Number(durationMs.toFixed(1))
    }
  };
}

async function updateWorkflowFromUser(context, emailId, requestedStatus) {
  const current = await context.workflowRepository.getWorkflowByEmailId(emailId);
  if (requestedStatus === 'pending_recognition') {
    if (current?.status !== 'not_applicable') throw new Error('只有无需处理邮件才能恢复到待识别状态');
  } else if (requestedStatus !== 'not_applicable') {
    throw new Error('不支持的人工状态变更');
  }
  return context.workflowRepository.upsertWorkflow({
    emailId,
    status: requestedStatus,
    reason: requestedStatus === 'not_applicable' ? '人工标记为无需处理' : '已恢复到待识别状态'
  });
}

function canCompleteManualReview(productMatches) {
  const summary = productMatches?.summary || {};
  const totalItems = Number(productMatches?.total_items) || 0;
  return totalItems > 0 && Number(summary.exact_match) === totalItems
    && !Number(summary.fuzzy_match) && !Number(summary.no_match) && !Number(summary.need_manual_review);
}

async function updateManualReviewFromUser(context, emailId, body) {
  const current = await context.workflowRepository.getWorkflowByEmailId(emailId);
  if (current?.status !== 'manual_review') throw new Error('只有人工核验中的邮件可以修改核验结果');
  const reviewNote = String(body?.review_note ?? current.review_note ?? '').trim();
  if (reviewNote.length > 1000) throw new Error('核验备注不能超过 1000 个字符');
  const confirmations = Array.isArray(body?.confirmations) ? body.confirmations : [];
  const itemEdit = body?.item_edit && typeof body.item_edit === 'object' ? body.item_edit : null;
  if (itemEdit && confirmations.length) throw new Error('请先保存识别信息修改，再确认产品候选');
  let recognitionOrderId = Number(current.recognition_order_id) || 0;
  if (!recognitionOrderId) {
    recognitionOrderId = Number((await context.orderRepository.getOrderRecognitionByEmailId(emailId))?.id) || 0;
  }
  if (!recognitionOrderId) throw new Error('该邮件没有可供人工核验的订单识别结果');
  let productMatches;
  if (itemEdit) {
    const updated = await context.orderRepository.updateOrderRecognitionItem(recognitionOrderId, {
      recognitionItemId: itemEdit.recognition_item_id,
      productModel: itemEdit.product_model,
      quantity: itemEdit.quantity,
      unit: itemEdit.unit
    });
    if (!updated) throw new Error('待修改的产品不存在');
    recognitionOrderId = updated.id;
    productMatches = await context.productMatchingService.matchOrderRecognition(recognitionOrderId);
  } else {
    productMatches = confirmations.length
      ? await context.productMatchingService.confirmManualMatches(recognitionOrderId, confirmations)
      : await context.productMatchingService.getOrderMatches(recognitionOrderId);
  }
  if (!productMatches) throw new Error('产品匹配结果不存在，请重新识别后再试');
  const complete = body?.complete === true;
  const canComplete = canCompleteManualReview(productMatches);
  if (complete && !canComplete) throw new Error('仍有待核验或未匹配产品，暂时不能完成核验');
  const workflow = await context.workflowRepository.upsertWorkflow({
    emailId,
    status: complete ? 'pending_confirmation' : 'manual_review',
    reason: complete ? '人工核验已完成，可删除邮件' : undefined,
    reviewNote
  });
  return { workflow, productMatches, can_complete: canComplete };
}

export async function handleCloudRequest(request, response) {
  try {
    const url = new URL(request.url, `https://${request.headers.host || 'orderbridge.local'}`);
    if (request.method === 'POST' && url.pathname === '/api/guest-session') {
      sendJson(response, 201, await createGuestWorkspace(request));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/public-config') {
      sendJson(response, 200, { supabase_url: getSupabaseUrl(), supabase_publishable_key: getSupabasePublishableKey() });
      return;
    }
    const context = await createUserContext(request);
    if (request.method === 'GET' && url.pathname === '/api/mail/config') {
      sendJson(response, 200, await getUserConfiguration(context.user.id));
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/mail/config') {
      const body = await readRequestBody(request);
      await verifyMailboxAccess(body);
      await verifyDeepSeekAccess(body);
      const config = await saveUserConfiguration(context.user.id, body);
      const shouldClear = body?.clear_imported_mails === true;
      if (shouldClear) await clearUserImportedMailCache(context.user.id);
      sendJson(response, 200, { ok: true, config, clear_imported_mails: shouldClear });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/mail-workflows') {
      sendJson(response, 200, { records: await context.workflowRepository.listWorkflows() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/mail/list') {
      sendJson(response, 200, await readUserStoredMails(context.user.id));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/mail/import') {
      sendJson(response, 200, { ok: true, ...(await importUserInbox(context.user.id, await readRequestBody(request))) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/mail/send') {
      sendJson(response, 200, await sendUserSmtpMail(context.user.id, await readRequestBody(request)));
      return;
    }
    const manualReview = url.pathname.match(/^\/api\/mail\/(.+)\/manual-review$/);
    if (request.method === 'PATCH' && manualReview) {
      const emailId = decodeURIComponent(manualReview[1]);
      if (!await findUserMail(context.user.id, emailId)) throw new HttpError(404, '邮件不存在');
      sendJson(response, 200, await updateManualReviewFromUser(context, emailId, await readRequestBody(request)));
      return;
    }
    const workflow = url.pathname.match(/^\/api\/mail\/(.+)\/workflow$/);
    if (request.method === 'PUT' && workflow) {
      const emailId = decodeURIComponent(workflow[1]);
      if (!await findUserMail(context.user.id, emailId)) throw new HttpError(404, '邮件不存在');
      const body = await readRequestBody(request);
      sendJson(response, 200, { record: await updateWorkflowFromUser(context, emailId, String(body?.status || '').trim()) });
      return;
    }
    const savedOrder = url.pathname.match(/^\/api\/mail\/(.+)\/order-result$/);
    if (request.method === 'GET' && savedOrder) {
      const recognition = await context.orderRepository.getOrderRecognitionByEmailId(decodeURIComponent(savedOrder[1]));
      if (!recognition) throw new HttpError(404, '这封邮件没有已保存的订单识别结果');
      sendJson(response, 200, { recognition, product_matches: await context.productMatchingService.getOrderMatches(recognition.id) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/order-recognitions') {
      sendJson(response, 200, { records: await context.orderRepository.listOrderRecognitions() });
      return;
    }
    const productMatches = url.pathname.match(/^\/api\/order-recognitions\/(\d+)\/product-matches$/);
    if (productMatches) {
      const result = request.method === 'POST'
        ? await context.productMatchingService.matchOrderRecognition(Number(productMatches[1]))
        : request.method === 'GET'
          ? await context.productMatchingService.getOrderMatches(Number(productMatches[1]))
          : undefined;
      if (result === undefined) throw new HttpError(404, '接口不存在');
      if (!result) throw new HttpError(404, '订单识别结果不存在');
      sendJson(response, 200, result);
      return;
    }
    const recognition = url.pathname.match(/^\/api\/order-recognitions\/(\d+)$/);
    if (request.method === 'GET' && recognition) {
      const result = await context.orderRepository.getOrderRecognition(Number(recognition[1]));
      if (!result) throw new HttpError(404, '订单识别结果不存在');
      sendJson(response, 200, result);
      return;
    }
    const extract = url.pathname.match(/^\/api\/mail\/(.+)\/extract-content$/);
    if (request.method === 'POST' && extract) {
      const mail = await findUserMail(context.user.id, decodeURIComponent(extract[1]));
      if (!mail) throw new HttpError(404, '邮件不存在');
      sendJson(response, 200, await withMaterializedAttachments(context.user.id, mail, extractEmailContent));
      return;
    }
    const analyze = url.pathname.match(/^\/api\/mail\/(.+)\/analyze-order$/);
    if (request.method === 'POST' && analyze) {
      const mail = await findUserMail(context.user.id, decodeURIComponent(analyze[1]));
      if (!mail) throw new HttpError(404, '邮件不存在');
      const extracted = await withMaterializedAttachments(context.user.id, mail, extractEmailContent);
      sendJson(response, 200, analyzeOrderContent(extracted));
      return;
    }
    const draft = url.pathname.match(/^\/api\/mail\/(.+)\/generate-order-draft$/);
    if (request.method === 'POST' && draft) {
      const startedAt = performance.now();
      const mail = await findUserMail(context.user.id, decodeURIComponent(draft[1]));
      if (!mail) throw new HttpError(404, '邮件不存在');
      let llm = {};
      try { llm = await getUserLlmRuntimeConfig(context.user.id); } catch {}
      const cacheKey = buildCacheKey(context.user.id, mail, llm);
      const cached = getCachedDraft(cacheKey);
      if (cached) {
        sendJson(response, 200, addProcessing(cached, { cacheHit: true, sharedRequest: false, durationMs: performance.now() - startedAt }));
        return;
      }
      const running = orderDraftInFlight.get(cacheKey);
      if (running) {
        const shared = await running;
        sendJson(response, 200, addProcessing(shared, { cacheHit: true, sharedRequest: true, durationMs: performance.now() - startedAt }));
        return;
      }
      const task = generateAndPersistOrderDraft(context, mail);
      orderDraftInFlight.set(cacheKey, task);
      try {
        const payload = await task;
        saveCachedDraft(cacheKey, payload);
        sendJson(response, 200, addProcessing(payload, { cacheHit: false, sharedRequest: false, durationMs: performance.now() - startedAt }));
      } finally {
        orderDraftInFlight.delete(cacheKey);
      }
      return;
    }
    throw new HttpError(404, '接口不存在');
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.status : 500, { error: sanitizeError(error) });
  }
}
