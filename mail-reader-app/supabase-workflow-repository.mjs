import { assertSupabase, getSupabaseServiceClient } from "./supabase-server.mjs";

const validStatuses = new Set([
  "pending_recognition",
  "pending_confirmation",
  "manual_review",
  "recognition_failed",
  "not_applicable",
  "processed"
]);

function cleanText(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function hydrateWorkflow(row) {
  if (!row) return null;
  return {
    email_id: row.email_id,
    status: row.status,
    recognition_order_id: row.recognition_order_id,
    recognition_provider: row.recognition_provider,
    recognition_status: row.recognition_status,
    reason: row.reason,
    review_note: row.review_note,
    updated_at: row.updated_at
  };
}

export function createSupabaseMailWorkflowRepository(userId) {
  const supabase = getSupabaseServiceClient();

  async function listWorkflows() {
    const result = await supabase
      .from("mail_workflows")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .order("email_id", { ascending: true });
    return (assertSupabase(result) || []).map(hydrateWorkflow);
  }

  async function getWorkflowByEmailId(emailId) {
    const result = await supabase
      .from("mail_workflows")
      .select("*")
      .eq("user_id", userId)
      .eq("email_id", String(emailId || "").trim())
      .maybeSingle();
    return hydrateWorkflow(assertSupabase(result));
  }

  async function upsertWorkflow(input = {}) {
    const emailId = String(input.emailId || "").trim();
    if (!emailId) throw new Error("邮件状态缺少 email_id");
    const current = await getWorkflowByEmailId(emailId);
    const status = input.status ?? current?.status ?? "pending_recognition";
    if (!validStatuses.has(status)) throw new Error("不支持的邮件处理状态");
    const record = {
      user_id: userId,
      email_id: emailId,
      status,
      recognition_order_id: input.recognitionOrderId !== undefined
        ? Number(input.recognitionOrderId) || null
        : current?.recognition_order_id ?? null,
      recognition_provider: input.recognitionProvider !== undefined
        ? cleanText(input.recognitionProvider, 120)
        : current?.recognition_provider ?? "",
      recognition_status: input.recognitionStatus !== undefined
        ? cleanText(input.recognitionStatus, 120)
        : current?.recognition_status ?? "",
      reason: input.reason !== undefined ? cleanText(input.reason) : current?.reason ?? "",
      review_note: input.reviewNote !== undefined ? cleanText(input.reviewNote) : current?.review_note ?? "",
      updated_at: new Date().toISOString()
    };
    const result = await supabase
      .from("mail_workflows")
      .upsert(record, { onConflict: "user_id,email_id" })
      .select("*")
      .single();
    return hydrateWorkflow(assertSupabase(result));
  }

  return { listWorkflows, getWorkflowByEmailId, upsertWorkflow };
}
