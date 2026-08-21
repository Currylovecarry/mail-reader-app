import { assertSupabase, getSupabaseServiceClient } from "./supabase-server.mjs";

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeModel(value) {
  return cleanText(value)
    .toUpperCase()
    .replace(/_/g, "-")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9.-]/g, "");
}

function normalizeOrderDraft(orderDraft) {
  const requirements = orderDraft?.requirements || {};
  const rawItems = Array.isArray(orderDraft?.products) ? orderDraft.products : [];
  const items = rawItems.map((item, index) => ({
    lineNo: positiveInteger(item?.line_no) || index + 1,
    modelRaw: cleanText(item?.product_model),
    modelNormalized: normalizeModel(item?.product_model),
    quantity: nullableNumber(item?.quantity),
    unit: cleanText(item?.unit),
    confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0))
  })).filter((item) => item.modelRaw || item.quantity !== null || item.unit);
  const seen = new Set();
  const normalizedItems = items.some((item) => seen.has(item.lineNo) || !seen.add(item.lineNo))
    ? items.map((item, index) => ({ ...item, lineNo: index + 1 }))
    : items;
  return {
    emailId: cleanText(orderDraft?.email_id),
    requirements: {
      company: cleanText(requirements.company),
      contactPerson: cleanText(requirements.contact_person),
      phone: cleanText(requirements.phone),
      projectName: cleanText(requirements.project_name),
      deliveryTerms: cleanText(requirements.delivery_terms),
      deliveryDate: cleanText(requirements.delivery_date),
      destination: cleanText(requirements.destination),
      paymentTerms: cleanText(requirements.payment_terms)
    },
    items: normalizedItems
  };
}

export function createSupabaseOrderRecognitionRepository(userId) {
  const supabase = getSupabaseServiceClient();

  async function saveOrderDraft(orderDraft) {
    const draft = normalizeOrderDraft(orderDraft);
    if (!draft.emailId) throw new Error("订单识别结果缺少 email_id，无法保存");
    const now = new Date().toISOString();
    const orderResult = await supabase.from("recognition_orders").upsert({
      user_id: userId,
      email_id: draft.emailId,
      company: draft.requirements.company,
      contact_person: draft.requirements.contactPerson,
      phone: draft.requirements.phone,
      project_name: draft.requirements.projectName,
      delivery_terms: draft.requirements.deliveryTerms,
      delivery_date: draft.requirements.deliveryDate,
      destination: draft.requirements.destination,
      payment_terms: draft.requirements.paymentTerms,
      updated_at: now
    }, { onConflict: "user_id,email_id" }).select("id").single();
    const order = assertSupabase(orderResult);
    assertSupabase(await supabase
      .from("recognition_order_items")
      .delete()
      .eq("user_id", userId)
      .eq("recognition_order_id", order.id));
    if (draft.items.length) {
      assertSupabase(await supabase.from("recognition_order_items").insert(draft.items.map((item) => ({
        user_id: userId,
        recognition_order_id: order.id,
        line_no: item.lineNo,
        model_raw: item.modelRaw,
        model_normalized: item.modelNormalized,
        quantity: item.quantity,
        unit: item.unit,
        confidence: item.confidence
      }))));
    }
    return getOrderRecognition(order.id);
  }

  async function listOrderRecognitions() {
    const result = await supabase
      .from("recognition_orders")
      .select("id")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
    const records = assertSupabase(result) || [];
    return Promise.all(records.map((record) => getOrderRecognition(record.id)));
  }

  async function getOrderRecognition(id) {
    const orderId = positiveInteger(id);
    if (!orderId) return null;
    const orderResult = await supabase
      .from("recognition_orders")
      .select("*")
      .eq("user_id", userId)
      .eq("id", orderId)
      .maybeSingle();
    const order = assertSupabase(orderResult);
    if (!order) return null;
    const itemsResult = await supabase
      .from("recognition_order_items")
      .select("id, line_no, model_raw, model_normalized, quantity, unit, confidence")
      .eq("user_id", userId)
      .eq("recognition_order_id", orderId)
      .order("line_no", { ascending: true })
      .order("id", { ascending: true });
    const items = (assertSupabase(itemsResult) || []).map((item) => ({
      recognition_item_id: item.id,
      line_no: item.line_no,
      model_raw: item.model_raw,
      model_normalized: item.model_normalized,
      quantity: item.quantity === null ? null : Number(item.quantity),
      unit: item.unit,
      confidence: Number(item.confidence)
    }));
    return {
      id: order.id,
      email_id: order.email_id,
      requirements: {
        company: order.company,
        contact_person: order.contact_person,
        phone: order.phone,
        project_name: order.project_name,
        delivery_terms: order.delivery_terms,
        delivery_date: order.delivery_date,
        destination: order.destination,
        payment_terms: order.payment_terms
      },
      items,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  async function getOrderRecognitionByEmailId(emailId) {
    const result = await supabase
      .from("recognition_orders")
      .select("id")
      .eq("user_id", userId)
      .eq("email_id", String(emailId || "").trim())
      .maybeSingle();
    const order = assertSupabase(result);
    return order ? getOrderRecognition(order.id) : null;
  }

  async function updateOrderRecognitionItem(recognitionOrderId, input) {
    const order = await getOrderRecognition(recognitionOrderId);
    const itemId = positiveInteger(input?.recognitionItemId);
    if (!order || !itemId) return null;
    const target = order.items.find((item) => Number(item.recognition_item_id) === itemId);
    if (!target) throw new Error("待修改的产品不属于当前订单");
    const productModel = cleanText(input?.productModel);
    const quantity = nullableNumber(input?.quantity);
    const unit = cleanText(input?.unit);
    if (!productModel || quantity === null || quantity <= 0 || !unit) {
      throw new Error("型号、正数数量和单位均为必填项");
    }
    return saveOrderDraft({
      email_id: order.email_id,
      requirements: order.requirements,
      products: order.items.map((item) => ({
        line_no: item.line_no,
        product_model: Number(item.recognition_item_id) === itemId ? productModel : item.model_raw,
        quantity: Number(item.recognition_item_id) === itemId ? quantity : item.quantity,
        unit: Number(item.recognition_item_id) === itemId ? unit : item.unit,
        confidence: Number(item.recognition_item_id) === itemId ? 1 : item.confidence
      }))
    });
  }

  return {
    saveOrderDraft,
    listOrderRecognitions,
    getOrderRecognition,
    getOrderRecognitionByEmailId,
    updateOrderRecognitionItem
  };
}
