import { analyzeOrderContent } from "./order-analysis-service.mjs";
import { buildOrderDraftPrompt } from "./llm-order-prompt.mjs";

export const BUSINESS_TYPE_LABELS = {
  BT1: "初次询盘",
  BT2: "追单邮件",
  BT3: "样品申请",
  BT4: "投诉反馈",
  BT5: "合作咨询",
  BT6: "售后凭证",
  unknown: "待确认"
};

const PRODUCT_TYPE_LABELS = {
  PT1: "标准品",
  PT2: "定制品",
  PT3: "备件",
  PT4: "整机设备"
};

const REQUIRED_REQUIREMENT_FIELDS = [
  "delivery_terms",
  "delivery_date",
  "destination",
  "payment_terms",
  "contact_person",
  "phone",
  "company",
  "project_name"
];
const MISSING_FIELD_LABELS = {
  delivery_terms: "报价/交付条款",
  delivery_date: "交期",
  destination: "收货地址",
  payment_terms: "付款条款",
  contact_person: "联系人",
  phone: "联系电话",
  company: "公司名称",
  project_name: "项目名称"
};

export async function generateOrderDraft(extractedContent, options = {}) {
  const structuredHints = buildStructuredHints(extractedContent);
  const fastPathPayload = createStructuredFastPathPayload(extractedContent, structuredHints, options);
  if (fastPathPayload) {
    return fastPathPayload;
  }

  const prompt = buildOrderDraftPrompt(extractedContent, structuredHints);
  const invokeLlm = options.invokeLlm || invokeOpenAiCompatibleLlm;

  let rawLlmResponse = "";
  try {
    rawLlmResponse = await invokeLlm(prompt, options);
    const parsed = safeParseJson(rawLlmResponse);
    if (!parsed.ok) {
      const fallbackDraft = normalizeDraft({}, extractedContent, structuredHints);
      if (hasRecognizedProducts(fallbackDraft)) {
        return createPartialSuccessPayload(
          extractedContent,
          rawLlmResponse,
          [parsed.error],
          fallbackDraft
        );
      }
      return createParseFailedPayload(extractedContent, rawLlmResponse, [parsed.error], options);
    }

    const normalized = normalizeDraft(parsed.value, extractedContent, structuredHints);
    const validationErrors = validateOrderDraft(normalized);
    if (validationErrors.length) {
      if (hasRecognizedProducts(normalized)) {
        return createPartialSuccessPayload(
          extractedContent,
          rawLlmResponse,
          validationErrors,
          normalized
        );
      }
      return createParseFailedPayload(extractedContent, rawLlmResponse, validationErrors, options, normalized);
    }

    const partialReasons = [];
    if (normalized.business_type?.code === "unknown") {
      partialReasons.push("业务类型待人工确认");
    }
    if (normalized.product_type?.code === "unknown") {
      partialReasons.push("产品类别待人工确认");
    }
    if (partialReasons.length) {
      return createPartialSuccessPayload(
        extractedContent,
        rawLlmResponse,
        partialReasons,
        normalized
      );
    }

    return {
      status: "success",
      email_id: extractedContent?.email_id || "",
      plain_summary: buildPlainSummary(normalized),
      provider: "openai_compatible",
      model: getLlmConfig().model,
      extracted_block_count: Array.isArray(extractedContent?.content_blocks) ? extractedContent.content_blocks.length : 0,
      order_draft: normalized,
      raw_llm_response: rawLlmResponse,
      validation_errors: [],
      error: ""
    };
  } catch (error) {
    const fallbackDraft = normalizeDraft({}, extractedContent, structuredHints);
    if (hasRecognizedProducts(fallbackDraft)) {
      return createPartialSuccessPayload(
        extractedContent,
        rawLlmResponse,
        [error?.message || "LLM 调用失败"],
        fallbackDraft
      );
    }
    return createParseFailedPayload(
      extractedContent,
      rawLlmResponse,
      [error?.message || "LLM 调用失败"],
      options
    );
  }
}

async function invokeOpenAiCompatibleLlm(prompt) {
  const config = getLlmConfig();
  if (!config.apiKey) {
    throw new Error("缺少 LLM_API_KEY，无法生成订单草稿");
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      ...(config.useJsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || `LLM 请求失败（HTTP ${response.status}）`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || "").join("").trim();
  }
  throw new Error("LLM 未返回可解析内容");
}

function getLlmConfig() {
  const baseUrl = String(process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    baseUrl,
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    apiKey: process.env.LLM_API_KEY || "",
    timeoutMs: clampTimeout(process.env.LLM_TIMEOUT_MS, 30_000),
    useJsonMode: /api\.deepseek\.com(?:\/v1)?$/i.test(baseUrl)
  };
}

function createStructuredFastPathPayload(extractedContent, structuredHints, options) {
  if (options.forceLlm === true || options.structuredFastPath === false) {
    return null;
  }

  const products = structuredHints?.structured_products || [];
  const businessType = structuredHints?.heuristic_analysis?.business_type || {};
  const productType = structuredHints?.heuristic_analysis?.product_type || {};
  if (!isHighConfidenceStructuredInput(products, businessType, productType)) {
    return null;
  }

  const orderDraft = normalizeDraft({}, extractedContent, structuredHints);
  orderDraft.evidence.business_type = findClassificationEvidence(
    extractedContent?.content_blocks,
    businessType
  );
  orderDraft.evidence.product_type = normalizeEvidence(products[0]?.evidence);

  const validationErrors = validateOrderDraft(orderDraft);
  if (validationErrors.length) {
    return null;
  }

  return {
    status: "success",
    email_id: extractedContent?.email_id || "",
    plain_summary: buildPlainSummary(orderDraft),
    provider: "local_structured",
    model: "local-structured-v1",
    extracted_block_count: Array.isArray(extractedContent?.content_blocks) ? extractedContent.content_blocks.length : 0,
    order_draft: orderDraft,
    raw_llm_response: "",
    validation_errors: [],
    error: "",
    processing: {
      mode: "structured_fast_path",
      llm_called: false
    }
  };
}

function isHighConfidenceStructuredInput(products, businessType, productType) {
  const validBusinessType = BUSINESS_TYPE_LABELS[businessType?.code]
    && businessType.code !== "unknown"
    && Number(businessType.confidence) >= 0.72;
  const validProductType = PRODUCT_TYPE_LABELS[productType?.code]
    && Number(productType.confidence) >= 0.72;
  const completeProducts = Array.isArray(products)
    && products.length > 0
    && products.every((product) => {
      const evidenceType = String(product?.evidence?.content_block_type || "");
      const quantity = Number(product?.quantity);
      return ["spreadsheet", "table"].includes(evidenceType)
        && Number(product?.confidence) >= 0.9
        && Boolean(String(product?.product_model || "").trim())
        && Boolean(String(product?.product_name || "").trim())
        && Number.isFinite(quantity)
        && quantity > 0
        && Boolean(String(product?.unit || "").trim())
        && Boolean(String(product?.evidence?.source || "").trim())
        && Boolean(String(product?.evidence?.raw_text || "").trim());
    });

  return Boolean(validBusinessType && validProductType && completeProducts);
}

function findClassificationEvidence(contentBlocks, classification) {
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  const keywords = Array.isArray(classification?.matched_keywords)
    ? classification.matched_keywords
    : [];

  for (const keyword of keywords) {
    const normalizedKeyword = String(keyword || "").toLowerCase();
    if (!normalizedKeyword) {
      continue;
    }
    const blockIndex = blocks.findIndex((block) =>
      String(block?.text || "").toLowerCase().includes(normalizedKeyword)
    );
    if (blockIndex >= 0) {
      return createEvidence(blocks[blockIndex], keyword, { blockIndex });
    }
  }

  const fallbackIndex = blocks.findIndex((block) => ["body_text", "spreadsheet", "table"].includes(block?.type));
  return fallbackIndex >= 0
    ? createEvidence(blocks[fallbackIndex], String(classification?.reason || ""), { blockIndex: fallbackIndex })
    : null;
}

function clampTimeout(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(5_000, Math.min(120_000, Math.round(parsed)));
}

function buildStructuredHints(extractedContent) {
  const analysis = analyzeOrderContent(extractedContent || {});
  const products = extractStructuredProducts(extractedContent?.content_blocks || []);
  const requirements = extractStructuredRequirements(extractedContent?.content_blocks || []);

  return {
    heuristic_analysis: {
      business_type: analysis.business_type,
      product_type: analysis.product_type,
      quantities: analysis.quantities,
      product_models: analysis.product_models
    },
    structured_products: products,
    structured_requirements: requirements
  };
}

function extractStructuredProducts(contentBlocks) {
  const products = [];

  (Array.isArray(contentBlocks) ? contentBlocks : []).forEach((block, blockIndex) => {
    if (["spreadsheet", "table", "image_ocr"].includes(block?.type) && Array.isArray(block?.rows)) {
      block.rows.forEach((row, rowIndex) => {
        if (!row || typeof row !== "object") {
          return;
        }

        const lineNo = pickRowValue(row, ["序号", "line_no", "line", "item", "itemno", "序列"]);
        const productModel = pickRowValue(row, ["产品型号", "型号", "model", "modelno", "itemno", "partnumber", "部件号", "货号", "料号"]);
        const productName = pickRowValue(row, ["产品名称", "名称", "品名", "productname", "name", "description", "itemname"]);
        const quantityText = pickRowValue(row, ["数量", "订购数量", "采购数量", "需求数量", "qty", "quantity", "orderqty", "orderquantity", "requiredquantity"]);
        const unit = pickRowValue(row, ["单位", "unit", "uom"]);
        const specifications = pickRowValue(row, ["规格", "spec", "specification", "specifications"]);
        const remarks = pickRowValue(row, ["备注", "remark", "remarks", "note", "notes"]);
        const rawText = buildRowRawText(row);

        if (!productModel && !productName && !quantityText) {
          return;
        }

        products.push({
          line_no: toInteger(lineNo) || rowIndex + 1,
          product_model: productModel,
          product_name: productName,
          quantity: parseNullableNumber(quantityText),
          unit,
          specifications,
          remarks,
          confidence: 0.95,
          evidence: {
            source: block.source || "",
            content_block_type: block.type || "",
            block_index: blockIndex,
            row_index: rowIndex + 1,
            raw_text: rawText
          }
        });
      });
    }

    if (["body_text", "pdf_text", "image_ocr"].includes(block?.type) && block?.text) {
      products.push(...extractLabeledTextProducts(block, blockIndex, products.length));
    }
  });

  const seen = new Set();
  return products.filter((product) => {
    const key = `${normalizeToken(product.product_model)}|${normalizeToken(product.product_name)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractLabeledTextProducts(block, blockIndex, lineOffset = 0) {
  const lines = String(block.text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const products = [];
  const modelPattern = /^(?:部件号|part\s*(?:number|no\.?)|item\s*(?:number|no\.?)|料号|货号|产品型号|型号)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,60})\s*$/i;

  lines.forEach((line, lineIndex) => {
    const modelMatch = line.match(modelPattern);
    if (!modelMatch) {
      return;
    }

    const previousLine = lines[lineIndex - 1] || "";
    const productName = previousLine
      .replace(/\s*[¥￥$]\s*[\d,.]+\s*$/u, "")
      .trim();
    if (!productName || /^(?:总计|小计|付款方式|应付|合计)$/i.test(productName)) {
      return;
    }

    products.push({
      line_no: lineOffset + products.length + 1,
      product_model: modelMatch[1].trim(),
      product_name: productName,
      quantity: null,
      unit: "",
      specifications: "",
      remarks: "",
      confidence: block.type === "pdf_text" ? 0.9 : 0.82,
      evidence: {
        source: block.source || block.metadata?.filename || "",
        content_block_type: block.type || "",
        block_index: blockIndex,
        row_index: null,
        raw_text: `${previousLine}\n${line}`.trim()
      }
    });
  });

  return products;
}

function extractStructuredRequirements(contentBlocks) {
  const requirements = createEmptyRequirements();
  const evidence = createEmptyRequirementEvidence();

  (Array.isArray(contentBlocks) ? contentBlocks : []).forEach((block, blockIndex) => {
    if (block?.type === "spreadsheet") {
      const metadata = block?.metadata?.sheet_metadata || {};
      assignRequirementFromMetadata(requirements, evidence, metadata, block, blockIndex);
    }

    if (block?.type === "body_text" || block?.type === "pdf_text" || block?.type === "image_ocr") {
      assignRequirementFromText(requirements, evidence, String(block.text || ""), block, blockIndex);
    }
  });

  return { values: requirements, evidence };
}

function assignRequirementFromMetadata(requirements, evidence, metadata, block, blockIndex) {
  const mappings = [
    ["project_name", ["项目", "项目名称", "project", "projectname"]],
    ["contact_person", ["客户联系人", "联系人", "contactperson", "contact", "contactname"]],
    ["phone", ["联系电话", "电话", "手机", "phone", "mobile", "tel"]],
    ["delivery_terms", ["报价条款", "贸易条款", "交货条款", "incoterms", "deliveryterms", "terms"]],
    ["payment_terms", ["付款条款", "付款方式", "paymentterms", "payment"]],
    ["destination", ["目的地", "交货地", "收货地址", "destination", "address"]],
    ["company", ["公司", "客户名称", "公司名称", "company", "customer"]],
    ["delivery_date", ["交期", "交货日期", "deliverydate", "delivery"]]
  ];

  mappings.forEach(([field, keys]) => {
    if (requirements[field]) {
      return;
    }
    const value = pickMetadataValue(metadata, keys);
    if (!value) {
      return;
    }
    requirements[field] = value;
    evidence[field] = {
      source: block.source || "",
      content_block_type: block.type || "",
      block_index: blockIndex,
      row_index: null,
      raw_text: `${keys[0]}: ${value}`
    };
  });
}

function assignRequirementFromText(requirements, evidence, text, block, blockIndex) {
  if (!requirements.delivery_terms) {
    const terms = text.match(/\b(EXW|FOB|CIF|CFR|DAP|DDP|FCA)\b/i);
    if (terms) {
      requirements.delivery_terms = terms[1].toUpperCase();
      evidence.delivery_terms = createEvidence(block, terms[0], { blockIndex });
    }
  }

  if (!requirements.phone) {
    const phone = text.match(/(?:\+?\d[\d\s-]{7,}\d)/);
    if (phone) {
      requirements.phone = phone[0].replace(/\s+/g, " ").trim();
      evidence.phone = createEvidence(block, phone[0], { blockIndex });
    }
  }

  if (!requirements.company) {
    const companyLine = text.split("\n").find((line) => /公司|有限公司|company|co\.,?\s*ltd/i.test(line));
    if (companyLine) {
      requirements.company = companyLine.trim();
      evidence.company = createEvidence(block, companyLine, { blockIndex });
    }
  }
}

function normalizeDraft(llmDraft, extractedContent, structuredHints) {
  const llmOrderDraft = llmDraft?.order_draft && typeof llmDraft.order_draft === "object"
    ? llmDraft.order_draft
    : llmDraft;
  const structuredProducts = structuredHints?.structured_products || [];
  const structuredRequirements = structuredHints?.structured_requirements?.values || createEmptyRequirements();
  const structuredRequirementEvidence = structuredHints?.structured_requirements?.evidence || createEmptyRequirementEvidence();
  const heuristicBusinessType = structuredHints?.heuristic_analysis?.business_type || {};
  const heuristicProductType = structuredHints?.heuristic_analysis?.product_type || {};

  const llmProducts = Array.isArray(llmOrderDraft?.products) ? llmOrderDraft.products : [];
  const warnings = new Set(normalizeStringArray(llmOrderDraft?.warnings));
  const mergedProducts = mergeProducts(structuredProducts, llmProducts, warnings);
  const requirements = mergeRequirements(llmOrderDraft?.requirements || {}, structuredRequirements);
  const evidence = mergeTopLevelEvidence(llmOrderDraft?.evidence || {}, structuredRequirementEvidence);

  const businessType = normalizeClassification(
    llmOrderDraft?.business_type,
    BUSINESS_TYPE_LABELS,
    heuristicBusinessType
  );
  const productType = normalizeClassification(
    llmOrderDraft?.product_type,
    PRODUCT_TYPE_LABELS,
    heuristicProductType
  );

  const missingFields = buildMissingFields(requirements);

  if (!businessType.code) {
    warnings.add("business_type 缺少明确结论");
  }
  if (!productType.code) {
    warnings.add("product_type 缺少明确结论");
  }

  mergedProducts.forEach((product) => {
    if (!product.evidence?.source || !product.evidence?.raw_text) {
      warnings.add(`第 ${product.line_no || "?"} 行产品 evidence 不完整`);
      product.confidence = Math.min(product.confidence, 0.6);
    }
    if (!product.product_model || !product.product_name || product.quantity === null || !product.unit) {
      warnings.add(`第 ${product.line_no || "?"} 行产品关键信息缺失`);
      product.confidence = Math.min(product.confidence, 0.65);
    }
  });

  if (missingFields.length) {
    warnings.add(`客户未提供 ${missingFields.join("、")}`);
  }

  return {
    email_id: extractedContent?.email_id || llmOrderDraft?.email_id || "",
    business_type: businessType,
    product_type: productType,
    products: mergedProducts,
    requirements,
    missing_fields: missingFields,
    warnings: [...warnings],
    evidence
  };
}

function mergeProducts(structuredProducts, llmProducts, warnings) {
  if (!structuredProducts.length) {
    return llmProducts.map((product, index) => normalizeProduct(product, index + 1));
  }

  return structuredProducts.map((structuredProduct, index) => {
    const normalizedStructured = normalizeProduct(structuredProduct, index + 1);
    const llmProduct = matchLlmProduct(normalizedStructured, llmProducts);
    if (!llmProduct) {
      return normalizedStructured;
    }

    const normalizedLlm = normalizeProduct(llmProduct, normalizedStructured.line_no || index + 1);
    if (
      normalizedStructured.quantity !== null &&
      normalizedLlm.quantity !== null &&
      normalizedStructured.quantity !== normalizedLlm.quantity
    ) {
      warnings.add("LLM quantity differs from structured quantity");
    }

    return {
      ...normalizedLlm,
      line_no: normalizedStructured.line_no,
      product_model: normalizedStructured.product_model || normalizedLlm.product_model,
      product_name: normalizedStructured.product_name || normalizedLlm.product_name,
      quantity: normalizedStructured.quantity ?? normalizedLlm.quantity,
      unit: normalizedStructured.unit || normalizedLlm.unit,
      specifications: normalizedLlm.specifications || normalizedStructured.specifications,
      remarks: normalizedLlm.remarks || normalizedStructured.remarks,
      confidence: Math.max(Math.min(normalizedLlm.confidence, 0.98), normalizedStructured.confidence),
      evidence: normalizedStructured.evidence?.source ? normalizedStructured.evidence : normalizedLlm.evidence
    };
  });
}

function matchLlmProduct(structuredProduct, llmProducts) {
  const candidates = Array.isArray(llmProducts) ? llmProducts : [];
  return candidates.find((product) => {
    const sameLine = toInteger(product?.line_no) && toInteger(product?.line_no) === structuredProduct.line_no;
    const sameModel = normalizeToken(product?.product_model) && normalizeToken(product?.product_model) === normalizeToken(structuredProduct.product_model);
    const sameName = normalizeToken(product?.product_name) && normalizeToken(product?.product_name) === normalizeToken(structuredProduct.product_name);
    return sameLine || sameModel || sameName;
  });
}

function normalizeProduct(product, fallbackLineNo) {
  const evidence = normalizeEvidence(product?.evidence);
  return {
    line_no: toInteger(product?.line_no) || fallbackLineNo,
    product_model: String(product?.product_model || "").trim(),
    product_name: String(product?.product_name || "").trim(),
    quantity: parseNullableNumber(product?.quantity),
    unit: String(product?.unit || "").trim(),
    specifications: String(product?.specifications || "").trim(),
    remarks: String(product?.remarks || "").trim(),
    confidence: clampConfidence(product?.confidence, 0.75),
    evidence: evidence || createEmptyProductEvidence()
  };
}

function mergeRequirements(llmRequirements, structuredRequirements) {
  const merged = createEmptyRequirements();
  REQUIRED_REQUIREMENT_FIELDS.forEach((field) => {
    merged[field] = String(structuredRequirements?.[field] || llmRequirements?.[field] || "").trim();
  });
  return merged;
}

function mergeTopLevelEvidence(llmEvidence, structuredRequirementEvidence) {
  const requirementsEvidence = createEmptyRequirementEvidence();
  REQUIRED_REQUIREMENT_FIELDS.forEach((field) => {
    requirementsEvidence[field] = normalizeEvidence(llmEvidence?.requirements?.[field]) || structuredRequirementEvidence[field] || null;
    if (!requirementsEvidence[field] && structuredRequirementEvidence[field]) {
      requirementsEvidence[field] = structuredRequirementEvidence[field];
    }
  });

  return {
    business_type: normalizeEvidence(llmEvidence?.business_type),
    product_type: normalizeEvidence(llmEvidence?.product_type),
    requirements: requirementsEvidence
  };
}

function normalizeClassification(value, labels, fallback = {}) {
  const valueIsString = typeof value === "string";
  const requestedCode = String(valueIsString ? value : value?.code || "").trim();
  const fallbackCode = String(typeof fallback === "string" ? fallback : fallback?.code || "").trim();
  const fallbackConfidence = clampConfidence(fallback?.confidence, 0);
  const code = labels[requestedCode]
    ? requestedCode
    : labels[fallbackCode]
      ? fallbackCode
      : "";
  const classificationSource = code === fallbackCode && code !== requestedCode ? fallback : value;
  const stringConfidence = valueIsString && code === requestedCode ? Math.max(fallbackCode === code ? fallbackConfidence : 0, 0.6) : 0;
  const stringReason = valueIsString && code === requestedCode
    ? fallbackCode === code && fallback?.reason
      ? fallback.reason
      : `LLM 返回分类代码 ${code}`
    : "";
  return {
    code: labels[code] ? code : "",
    label: labels[code] || String(classificationSource?.label || fallback?.label || "").trim(),
    confidence: stringConfidence || clampConfidence(classificationSource?.confidence, fallbackConfidence),
    reason: String(
      classificationSource?.reason
      || stringReason
      || fallback?.reason
    ).trim()
  };
}

function buildMissingFields(requirements) {
  return REQUIRED_REQUIREMENT_FIELDS.filter((field) => !String(requirements?.[field] || "").trim());
}

function validateOrderDraft(orderDraft) {
  const errors = [];
  if (!orderDraft || typeof orderDraft !== "object") {
    return ["order_draft 必须是对象"];
  }

  if (!String(orderDraft.email_id || "").trim()) {
    errors.push("email_id 不能为空");
  }

  validateClassification(orderDraft.business_type, "business_type", BUSINESS_TYPE_LABELS, errors);
  validateClassification(orderDraft.product_type, "product_type", PRODUCT_TYPE_LABELS, errors);

  if (!Array.isArray(orderDraft.products)) {
    errors.push("products 必须是数组");
  } else {
    orderDraft.products.forEach((product, index) => validateProduct(product, index, errors));
  }

  if (!orderDraft.requirements || typeof orderDraft.requirements !== "object") {
    errors.push("requirements 必须存在");
  } else {
    REQUIRED_REQUIREMENT_FIELDS.forEach((field) => {
      if (typeof orderDraft.requirements[field] !== "string") {
        errors.push(`requirements.${field} 必须是字符串`);
      }
    });
  }

  if (!Array.isArray(orderDraft.missing_fields)) {
    errors.push("missing_fields 必须是数组");
  }
  if (!Array.isArray(orderDraft.warnings)) {
    errors.push("warnings 必须是数组");
  }

  if (!orderDraft.evidence || typeof orderDraft.evidence !== "object") {
    errors.push("evidence 必须存在");
  }

  return errors;
}

function validateClassification(value, fieldName, labels, errors) {
  if (!value || typeof value !== "object") {
    errors.push(`${fieldName} 必须是对象`);
    return;
  }
  if (!labels[value.code]) {
    errors.push(`${fieldName}.code 必须是 ${Object.keys(labels).join("/")}`);
  }
  if (typeof value.label !== "string") {
    errors.push(`${fieldName}.label 必须是字符串`);
  }
  if (!Number.isFinite(Number(value.confidence))) {
    errors.push(`${fieldName}.confidence 必须是数字`);
  }
  if (typeof value.reason !== "string") {
    errors.push(`${fieldName}.reason 必须是字符串`);
  }
}

function validateProduct(product, index, errors) {
  const prefix = `products[${index}]`;
  if (!product || typeof product !== "object") {
    errors.push(`${prefix} 必须是对象`);
    return;
  }
  if (!Number.isFinite(Number(product.line_no))) {
    errors.push(`${prefix}.line_no 必须是数字`);
  }
  if (typeof product.product_model !== "string") {
    errors.push(`${prefix}.product_model 必须是字符串`);
  }
  if (typeof product.product_name !== "string") {
    errors.push(`${prefix}.product_name 必须是字符串`);
  }
  if (!(product.quantity === null || Number.isFinite(Number(product.quantity)))) {
    errors.push(`${prefix}.quantity 必须是数字或 null`);
  }
  if (typeof product.unit !== "string") {
    errors.push(`${prefix}.unit 必须是字符串`);
  }
  if (typeof product.specifications !== "string") {
    errors.push(`${prefix}.specifications 必须是字符串`);
  }
  if (typeof product.remarks !== "string") {
    errors.push(`${prefix}.remarks 必须是字符串`);
  }
  if (!Number.isFinite(Number(product.confidence))) {
    errors.push(`${prefix}.confidence 必须是数字`);
  }
  if (!product.evidence || typeof product.evidence !== "object") {
    errors.push(`${prefix}.evidence 必须存在`);
  } else {
    ["source", "content_block_type", "raw_text"].forEach((field) => {
      if (typeof product.evidence[field] !== "string") {
        errors.push(`${prefix}.evidence.${field} 必须是字符串`);
      }
    });
    if (!(product.evidence.row_index === null || Number.isFinite(Number(product.evidence.row_index)))) {
      errors.push(`${prefix}.evidence.row_index 必须是数字或 null`);
    }
    if (!(product.evidence.block_index === null || Number.isFinite(Number(product.evidence.block_index)))) {
      errors.push(`${prefix}.evidence.block_index 必须是数字或 null`);
    }
  }
}

function createParseFailedPayload(extractedContent, rawLlmResponse, validationErrors, _options, partialDraft = null) {
  return {
    status: "parse_failed",
    email_id: extractedContent?.email_id || "",
    plain_summary: partialDraft ? buildPlainSummary(partialDraft) : "",
    provider: "openai_compatible",
    model: getLlmConfig().model,
    extracted_block_count: Array.isArray(extractedContent?.content_blocks) ? extractedContent.content_blocks.length : 0,
    order_draft: partialDraft,
    raw_llm_response: rawLlmResponse,
    validation_errors: validationErrors,
    error: validationErrors.join("; ")
  };
}

function createPartialSuccessPayload(extractedContent, rawLlmResponse, partialReasons, partialDraft) {
  const reasons = normalizeStringArray(partialReasons);
  const orderDraft = {
    ...partialDraft,
    warnings: [...new Set([
      ...normalizeStringArray(partialDraft?.warnings),
      ...reasons.map((reason) => `部分识别：${reason}`)
    ])]
  };
  return {
    status: "partial_success",
    email_id: extractedContent?.email_id || "",
    plain_summary: buildPlainSummary(orderDraft),
    provider: "openai_compatible",
    model: getLlmConfig().model,
    extracted_block_count: Array.isArray(extractedContent?.content_blocks) ? extractedContent.content_blocks.length : 0,
    order_draft: orderDraft,
    raw_llm_response: rawLlmResponse,
    validation_errors: reasons,
    partial_reasons: reasons,
    error: ""
  };
}

function hasRecognizedProducts(orderDraft) {
  return Array.isArray(orderDraft?.products) && orderDraft.products.some((product) =>
    String(product?.product_model || product?.product_name || "").trim()
  );
}

function buildPlainSummary(orderDraft) {
  if (!orderDraft || typeof orderDraft !== "object") {
    return "";
  }

  const businessType = String(orderDraft.business_type?.label || "").trim();
  const productType = String(orderDraft.product_type?.label || "").trim();
  const requirements = orderDraft.requirements || {};
  const products = Array.isArray(orderDraft.products) ? orderDraft.products : [];
  const missingFields = Array.isArray(orderDraft.missing_fields) ? orderDraft.missing_fields : [];
  const contactPerson = String(requirements.contact_person || "").trim();
  const company = String(requirements.company || "").trim();
  const projectName = String(requirements.project_name || "").trim();
  const deliveryTerms = String(requirements.delivery_terms || "").trim();

  const lines = [];

  if (businessType && orderDraft.business_type?.code !== "unknown") {
    lines.push(`这是一封${businessType}邮件。`);
  } else {
    lines.push("这封邮件的业务类型还需要进一步确认。");
  }

  const subjectParts = [];
  if (contactPerson) {
    subjectParts.push(`客户${contactPerson}`);
  }
  if (company) {
    subjectParts.push(`来自${company}`);
  }
  if (projectName) {
    subjectParts.push(`正在为“${projectName}”处理需求`);
  }

  if (subjectParts.length) {
    lines.push(`${subjectParts.join("，")}。`);
  }

  if (products.length) {
    const productLead = productType
      ? `当前识别到 ${products.length} 个${productType}`
      : `当前识别到 ${products.length} 个产品`;
    const productText = products
      .map((product) => {
        const name = String(product.product_name || "").trim();
        const model = String(product.product_model || "").trim();
        const quantity = product.quantity === null || product.quantity === undefined ? "" : String(product.quantity);
        const unit = String(product.unit || "").trim();
        const title = name || model || "未命名产品";
        const modelText = model ? `（${model}）` : "";
        const quantityText = quantity ? `数量：${quantity}${unit ? ` ${unit}` : ""}` : "数量未识别";
        return `${title}${modelText}${quantityText ? ` ${quantityText}` : ""}`.trim();
      })
      .join("、");
    lines.push(`${productLead}：${productText}。`);
  } else {
    lines.push("暂未识别到明确产品清单。");
  }

  if (deliveryTerms) {
    lines.push(`报价条款为 ${deliveryTerms}。`);
  }

  if (missingFields.length) {
    lines.push(`客户还没有提供${missingFields.map((field) => MISSING_FIELD_LABELS[field] || field).join("、")}。`);
  } else {
    lines.push("当前订单草稿没有明显缺失字段。");
  }

  return lines.join("");
}

function safeParseJson(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return { ok: false, error: "LLM 返回为空" };
  }

  const fenceMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : normalized;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: "LLM 返回中未找到合法 JSON 对象" };
  }

  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, error: `LLM JSON 解析失败: ${error.message}` };
  }
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    source: String(value.source || "").trim(),
    content_block_type: String(value.content_block_type || "").trim(),
    row_index: toNullableInteger(value.row_index),
    block_index: toNullableInteger(value.block_index),
    raw_text: String(value.raw_text || "").trim()
  };
}

function createEvidence(block, rawText, options = {}) {
  return {
    source: block?.source || "",
    content_block_type: block?.type || "",
    row_index: toNullableInteger(options.rowIndex),
    block_index: toNullableInteger(options.blockIndex),
    raw_text: String(rawText || "").trim()
  };
}

function createEmptyRequirements() {
  return REQUIRED_REQUIREMENT_FIELDS.reduce((result, field) => {
    result[field] = "";
    return result;
  }, {});
}

function createEmptyRequirementEvidence() {
  return REQUIRED_REQUIREMENT_FIELDS.reduce((result, field) => {
    result[field] = null;
    return result;
  }, {});
}

function createEmptyProductEvidence() {
  return {
    source: "",
    content_block_type: "",
    row_index: null,
    block_index: null,
    raw_text: ""
  };
}

function pickRowValue(row, aliases) {
  const entries = Object.entries(row || {});
  for (const alias of aliases) {
    const expected = normalizeToken(alias);
    const matched = entries.find(([key]) => normalizeToken(key) === expected);
    if (matched && String(matched[1] || "").trim()) {
      return String(matched[1] || "").trim();
    }
  }
  return "";
}

function buildRowRawText(row) {
  return Object.values(row || {})
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" | ");
}

function pickMetadataValue(metadata, aliases) {
  const entries = Object.entries(metadata || {});
  for (const alias of aliases) {
    const expected = normalizeToken(alias);
    const matched = entries.find(([key]) => normalizeToken(key) === expected);
    if (matched && String(matched[1] || "").trim()) {
      return String(matched[1] || "").trim();
    }
  }
  return "";
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_：:;；,.，、/\\()（）[\]{}-]+/g, "");
}

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
  if (!normalized) {
    return null;
  }
  const number = Number(normalized[0].replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function toInteger(value) {
  const parsed = parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampConfidence(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
}

function toNullableInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}
