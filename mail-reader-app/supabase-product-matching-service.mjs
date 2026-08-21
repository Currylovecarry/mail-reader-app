import { matchProduct } from "./product-matcher.mjs";
import { assertSupabase, getSupabaseServiceClient } from "./supabase-server.mjs";

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function summarizeItems(items) {
  const summary = { exact_match: 0, fuzzy_match: 0, no_match: 0, need_manual_review: 0 };
  for (const item of items) {
    if (!item.match) continue;
    summary[item.match.match_status] += 1;
    if (item.match.need_manual_review) summary.need_manual_review += 1;
  }
  return summary;
}

function buildPreliminaryQuote(items) {
  const lines = [];
  for (const item of items) {
    const match = item.match;
    const quantity = Number(item.quantity);
    if (!match || match.match_status !== "exact_match" || match.need_manual_review || !Number.isFinite(quantity)) continue;
    const candidate = (match.candidates || []).find((value) => Number(value.product_id) === Number(match.selected_product_id));
    if (!candidate || candidate.price === null || candidate.price === undefined || candidate.price === "") continue;
    const price = Number(candidate.price);
    if (!Number.isFinite(price)) continue;
    lines.push({
      recognition_item_id: item.recognition_item_id,
      line_no: item.line_no,
      product_id: candidate.product_id,
      product_code: candidate.product_code,
      quantity,
      unit: item.unit,
      unit_price: roundCurrency(price),
      line_total: roundCurrency(price * quantity)
    });
  }
  return {
    currency: "CNY",
    status: !items.length ? "unavailable" : lines.length === items.length ? "complete" : lines.length ? "partial" : "unavailable",
    total_items: items.length,
    priced_items: lines.length,
    unpriced_items: Math.max(0, items.length - lines.length),
    total_amount: roundCurrency(lines.reduce((total, line) => total + line.line_total, 0)),
    disclaimer: "测试价格，未含税费及运费，正式报价需人工确认",
    lines
  };
}

function buildPayload(order, items) {
  return {
    recognition_order_id: order.id,
    email_id: order.email_id,
    total_items: items.length,
    summary: summarizeItems(items),
    preliminary_quote: buildPreliminaryQuote(items),
    items
  };
}

function catalogRow(row) {
  return {
    ...row,
    id: Number(row.id),
    price: row.price === null ? null : Number(row.price),
    active: Boolean(row.active)
  };
}

export function createSupabaseProductMatchingService(userId, orderRepository) {
  const supabase = getSupabaseServiceClient();

  async function getCatalog() {
    const result = await supabase
      .from("product_catalog")
      .select("id, product_code, normalized_code, product_name, spec, unit, price, active")
      .eq("active", true)
      .order("normalized_code", { ascending: true });
    return (assertSupabase(result) || []).map(catalogRow);
  }

  async function previewOrderRecognition(recognitionOrderId) {
    const order = await orderRepository.getOrderRecognition(recognitionOrderId);
    if (!order) return null;
    const catalog = await getCatalog();
    return buildPayload(order, order.items.map((item) => ({
      ...item,
      match: matchProduct(item, catalog)
    })));
  }

  async function matchOrderRecognition(recognitionOrderId) {
    const preview = await previewOrderRecognition(recognitionOrderId);
    if (!preview) return null;
    const now = new Date().toISOString();
    const rows = preview.items.map((item) => ({
      user_id: userId,
      recognition_item_id: item.recognition_item_id,
      query_model_raw: item.model_raw,
      query_normalized_code: item.model_normalized,
      match_status: item.match.match_status,
      match_method: item.match.match_method,
      final_score: item.match.final_score,
      spec_warning: item.match.spec_warning,
      need_manual_review: item.match.need_manual_review,
      review_reason: item.match.review_reason,
      selected_product_id: item.match.selected_product_id || null,
      review_status: item.match.review_status,
      updated_at: now
    }));
    if (rows.length) {
      const results = await supabase
        .from("product_match_results")
        .upsert(rows, { onConflict: "recognition_item_id" })
        .select("id, recognition_item_id");
      const saved = assertSupabase(results) || [];
      const resultByItemId = new Map(saved.map((row) => [Number(row.recognition_item_id), row.id]));
      const resultIds = saved.map((row) => row.id);
      if (resultIds.length) {
        assertSupabase(await supabase.from("product_match_candidates")
          .delete()
          .eq("user_id", userId)
          .in("match_result_id", resultIds));
      }
      const candidates = preview.items.flatMap((item) => (item.match.candidates || []).map((candidate) => ({
        user_id: userId,
        match_result_id: resultByItemId.get(Number(item.recognition_item_id)),
        product_id: candidate.product_id,
        rank: candidate.rank,
        fuzzy_score: candidate.fuzzy_score,
        spec_score: candidate.spec_score,
        final_score: candidate.final_score,
        match_reason: candidate.match_reason
      }))).filter((candidate) => candidate.match_result_id);
      if (candidates.length) assertSupabase(await supabase.from("product_match_candidates").insert(candidates));
    }
    return getOrderMatches(recognitionOrderId);
  }

  async function getOrderMatches(recognitionOrderId) {
    const order = await orderRepository.getOrderRecognition(recognitionOrderId);
    if (!order) return null;
    const itemIds = order.items.map((item) => item.recognition_item_id);
    const resultQuery = itemIds.length
      ? await supabase.from("product_match_results").select("*").eq("user_id", userId).in("recognition_item_id", itemIds)
      : { data: [], error: null };
    const results = assertSupabase(resultQuery) || [];
    const resultByItemId = new Map(results.map((result) => [Number(result.recognition_item_id), result]));
    const resultIds = results.map((result) => result.id);
    const candidatesQuery = resultIds.length
      ? await supabase.from("product_match_candidates").select("*").eq("user_id", userId).in("match_result_id", resultIds).order("rank", { ascending: true })
      : { data: [], error: null };
    const candidates = assertSupabase(candidatesQuery) || [];
    const catalogIds = [...new Set(candidates.map((candidate) => candidate.product_id).filter(Boolean))];
    const catalogQuery = catalogIds.length
      ? await supabase.from("product_catalog").select("*").in("id", catalogIds)
      : { data: [], error: null };
    const catalog = new Map((assertSupabase(catalogQuery) || []).map((product) => [Number(product.id), catalogRow(product)]));
    const candidatesByResultId = new Map();
    for (const candidate of candidates) {
      const product = catalog.get(Number(candidate.product_id));
      if (!product) continue;
      const values = candidatesByResultId.get(candidate.match_result_id) || [];
      values.push({
        product_id: Number(candidate.product_id),
        rank: candidate.rank,
        product_code: product.product_code,
        normalized_code: product.normalized_code,
        product_name: product.product_name,
        spec: product.spec,
        unit: product.unit,
        price: product.price,
        fuzzy_score: asNumber(candidate.fuzzy_score),
        spec_score: asNumber(candidate.spec_score),
        final_score: asNumber(candidate.final_score),
        match_reason: candidate.match_reason
      });
      candidatesByResultId.set(candidate.match_result_id, values);
    }
    const items = order.items.map((item) => {
      const result = resultByItemId.get(Number(item.recognition_item_id));
      const selected = result?.selected_product_id ? catalog.get(Number(result.selected_product_id)) : null;
      return {
        ...item,
        match: result ? {
          id: result.id,
          match_status: result.match_status,
          match_method: result.match_method,
          final_score: asNumber(result.final_score),
          spec_warning: result.spec_warning,
          need_manual_review: Boolean(result.need_manual_review),
          review_reason: result.review_reason,
          selected_product_id: result.selected_product_id,
          selected_product_code: selected?.product_code || "",
          selected_normalized_code: selected?.normalized_code || "",
          review_status: result.review_status,
          candidates: candidatesByResultId.get(result.id) || []
        } : null
      };
    });
    return buildPayload(order, items);
  }

  async function confirmManualMatches(recognitionOrderId, confirmations) {
    const orderId = positiveInteger(recognitionOrderId);
    const entries = Array.isArray(confirmations) ? confirmations : [];
    if (!orderId || !entries.length) throw new Error("请至少选择一条待核验的产品匹配结果");
    const existing = await getOrderMatches(orderId);
    if (!existing) return null;
    const items = new Map(existing.items.map((item) => [Number(item.recognition_item_id), item]));
    const seen = new Set();
    for (const confirmation of entries) {
      const itemId = positiveInteger(confirmation?.recognition_item_id);
      const productId = positiveInteger(confirmation?.selected_product_id);
      const item = items.get(itemId);
      if (!itemId || !productId || seen.has(itemId) || !item?.match?.need_manual_review) {
        throw new Error("人工核验的产品选择不正确");
      }
      seen.add(itemId);
      if (!(item.match.candidates || []).some((candidate) => Number(candidate.product_id) === productId)) {
        throw new Error("只能确认当前产品库提供的候选项");
      }
      assertSupabase(await supabase.from("product_match_results").update({
        match_status: "exact_match",
        match_method: "manual_confirmed",
        final_score: 100,
        spec_warning: "",
        need_manual_review: false,
        review_reason: "",
        selected_product_id: productId,
        review_status: "confirmed",
        updated_at: new Date().toISOString()
      }).eq("user_id", userId).eq("recognition_item_id", itemId));
    }
    return getOrderMatches(orderId);
  }

  async function previewAllOrderRecognitions() {
    const orders = await orderRepository.listOrderRecognitions();
    const matched = await Promise.all(orders.map((order) => previewOrderRecognition(order.id)));
    return summarizeBatch(matched);
  }

  async function matchAllOrderRecognitions() {
    const orders = await orderRepository.listOrderRecognitions();
    const matched = await Promise.all(orders.map((order) => matchOrderRecognition(order.id)));
    return summarizeBatch(matched);
  }

  return { previewOrderRecognition, matchOrderRecognition, previewAllOrderRecognitions, matchAllOrderRecognitions, getOrderMatches, confirmManualMatches };
}

function summarizeBatch(results) {
  const valid = results.filter(Boolean);
  const summary = { orders: valid.length, items: 0, exact_match: 0, fuzzy_match: 0, no_match: 0, need_manual_review: 0 };
  for (const result of valid) {
    summary.items += result.total_items;
    summary.exact_match += result.summary.exact_match;
    summary.fuzzy_match += result.summary.fuzzy_match;
    summary.no_match += result.summary.no_match;
    summary.need_manual_review += result.summary.need_manual_review;
  }
  return { summary, orders: valid };
}
