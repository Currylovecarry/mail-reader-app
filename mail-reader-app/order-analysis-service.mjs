const quantityColumnNames = new Set([
  "qty",
  "quantity",
  "数量",
  "订购数量",
  "采购数量",
  "需求数量",
  "orderqty",
  "orderquantity",
  "requiredqty",
  "requiredquantity",
  "amount"
]);
const unitColumnNames = new Set(["单位", "unit", "uom"]);

const quantityUnits = ["pcs", "pieces", "units", "sets", "个", "件", "台", "套", "箱", "包"];
const quantityUnitPattern = "(pcs|pieces|units|sets|个|件|台|套|箱|包)";
const numberPattern = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?)";

const businessTypeRules = [
  {
    code: "BT1",
    label: "初次询盘",
    keywords: ["request for quotation", "quotation", "quote", "inquiry", "price", "rfq", "询价", "报价", "价格"],
    reason: "邮件中出现询价或报价相关表达"
  },
  {
    code: "BT2",
    label: "追单邮件",
    keywords: ["previous quotation", "regarding your offer", "follow up", "any update", "reminder", "跟进", "追问", "上次报价", "之前询价"],
    reason: "邮件中出现跟进历史报价或询价的表达"
  },
  {
    code: "BT3",
    label: "样品申请",
    keywords: ["test sample", "sample", "trial", "evaluation", "样品", "测试", "试用"],
    reason: "邮件中出现样品、测试或试用相关表达"
  },
  {
    code: "BT4",
    label: "投诉反馈",
    keywords: ["quality problem", "not working", "complaint", "issue", "defect", "damaged", "投诉", "质量问题", "损坏", "不能用", "故障"],
    reason: "邮件中出现质量、损坏、故障或投诉相关表达"
  },
  {
    code: "BT5",
    label: "合作咨询",
    keywords: ["partnership", "cooperation", "distributor", "dealer", "agency", "agent", "代理", "经销", "合作", "商务合作"],
    reason: "邮件中出现代理、经销或商务合作相关表达"
  }
];

const productTypeRules = [
  {
    code: "PT1",
    label: "标准品",
    keywords: ["model no.", "part number", "item no.", "standard model", "catalog", "model", "sku", "型号", "货号", "标准型号"],
    reason: "内容中出现型号、货号、SKU 或目录型产品表达"
  },
  {
    code: "PT2",
    label: "定制品",
    keywords: ["according to drawing", "made to order", "special size", "customized", "custom", "oem", "odm", "定制", "客制化", "按图纸", "特殊尺寸"],
    reason: "内容中出现定制、按图纸或特殊尺寸相关表达"
  },
  {
    code: "PT3",
    label: "备件",
    keywords: ["spare part", "replacement", "accessory", "component", "module", "备件", "配件", "零件", "替换件", "模块"],
    reason: "内容中出现备件、替换件、配件或模块相关表达"
  },
  {
    code: "PT4",
    label: "整机设备",
    keywords: ["production line", "complete set", "equipment", "machine", "system", "device", "设备", "整机", "系统", "生产线", "装置"],
    reason: "内容中出现设备、整机、系统或生产线相关表达"
  }
];

export function analyzeOrderContent(extractedContent) {
  const contentBlocks = Array.isArray(extractedContent?.content_blocks) ? extractedContent.content_blocks : [];
  const quantities = extractQuantities(contentBlocks);
  const businessType = classifyBusinessType(extractedContent, contentBlocks);
  const productType = classifyProductType(contentBlocks);
  const productModels = extractProductModels(contentBlocks);
  const warnings = collectWarnings(contentBlocks);
  const missingFields = [];

  if (!quantities.length) {
    missingFields.push("quantity");
  }
  if (businessType.code === "unknown") {
    missingFields.push("business_type");
  }
  if (productType.code === "unknown") {
    missingFields.push("product_type");
  }

  const payload = {
    email_id: extractedContent?.email_id || "",
    business_type: businessType,
    product_type: productType,
    product_models: productModels,
    quantities,
    warnings,
    missing_fields: missingFields
  };
  return {
    ...payload,
    summary_text: buildPlainSummary(payload)
  };
}

function buildPlainSummary(payload) {
  const lines = [];
  const businessType = payload.business_type;
  const productType = payload.product_type;

  if (businessType.code === "unknown") {
    lines.push("业务类型：暂时无法判断。");
  } else {
    lines.push(`业务类型：这封邮件看起来是「${businessType.label}」（${businessType.code}），置信度 ${toPercent(businessType.confidence)}。依据是匹配到：${businessType.matched_keywords.join("、")}。`);
  }

  if (productType.code === "unknown") {
    lines.push("产品类别：暂时无法判断。");
  } else {
    lines.push(`产品类别：更像是「${productType.label}」（${productType.code}），置信度 ${toPercent(productType.confidence)}。依据是匹配到：${productType.matched_keywords.join("、")}。`);
  }

  if (payload.product_models.length) {
    const modelText = uniqueModelsForSummary(payload.product_models)
      .slice(0, 5)
      .map((model) => `${model.value}（来自 ${model.source}，置信度 ${toPercent(model.confidence)}）`)
      .join("、");
    lines.push(`产品型号：识别到 ${modelText}。`);
  } else {
    lines.push("产品型号：没有识别到明确型号。");
  }

  if (payload.quantities.length) {
    lines.push(`数量信息：共识别到 ${payload.quantities.length} 条数量。`);
    payload.quantities.slice(0, 5).forEach((quantity, index) => {
      const unit = quantity.unit ? ` ${quantity.unit}` : "";
      const rowInfo = quantity.row_index ? `，第 ${quantity.row_index} 行` : "";
      lines.push(`${index + 1}. ${quantity.value}${unit}，来自 ${quantity.source}${rowInfo}，原文是「${quantity.raw_text}」，置信度 ${toPercent(quantity.confidence)}。`);
    });
    if (payload.quantities.length > 5) {
      lines.push(`另外还有 ${payload.quantities.length - 5} 条数量未在摘要中展开，可查看下方 JSON。`);
    }
  } else {
    lines.push("数量信息：没有识别到明确的产品数量，需要人工补充或检查附件内容。");
  }

  if (payload.missing_fields.length) {
    lines.push(`缺失信息：${payload.missing_fields.join("、")}。`);
  }

  if (payload.warnings.length) {
    lines.push(`注意：有 ${payload.warnings.length} 个附件解析警告，建议查看 JSON 中的 warnings。`);
  }

  return lines.join("\n");
}

function toPercent(confidence) {
  return `${Math.round((Number(confidence) || 0) * 100)}%`;
}

function uniqueModelsForSummary(models) {
  const seen = new Set();
  return models.filter((model) => {
    const key = String(model.value || "").toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractQuantities(contentBlocks) {
  const results = [];
  const seen = new Set();

  for (const block of contentBlocks) {
    if (["table", "spreadsheet", "image_ocr"].includes(block?.type) && Array.isArray(block?.rows)) {
      extractQuantitiesFromRows(block).forEach((item) => addUniqueQuantity(results, seen, item));
    }
  }

  for (const block of contentBlocks) {
    extractQuantitiesFromTextBlock(block).forEach((item) => addUniqueQuantity(results, seen, item));
  }

  return results.sort((left, right) => right.confidence - left.confidence);
}

function extractQuantitiesFromRows(block) {
  const rows = Array.isArray(block?.rows) ? block.rows : [];
  const quantities = [];
  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object") {
      return;
    }

    const rowUnit = findRowUnit(row);

    Object.entries(row).forEach(([columnName, value]) => {
      if (!isQuantityColumn(columnName)) {
        return;
      }

      const parsed = parseQuantityValue(value, `${columnName}: ${value}`, rowUnit);
      if (!parsed) {
        return;
      }

      quantities.push({
        value: parsed.value,
        unit: parsed.unit,
        raw_text: parsed.rawText,
        source: block.source || block.metadata?.filename || "content_block",
        content_block_type: block.type,
        row_index: rowIndex + 1,
        confidence: block.type === "spreadsheet" ? 0.95 : 0.93
      });
    });
  });
  return quantities;
}

function extractQuantitiesFromTextBlock(block) {
  if (!block?.text || block.type === "attachment") {
    return [];
  }

  const confidence = getTextQuantityConfidence(block.type);
  const source = block.source || block.metadata?.filename || "content_block";
  return findQuantityMatches(block.text).map((parsed) => ({
    value: parsed.value,
    unit: parsed.unit,
    raw_text: parsed.rawText,
    source,
    content_block_type: block.type || "unknown",
    confidence
  }));
}

function isQuantityColumn(columnName) {
  const normalized = normalizeColumnName(columnName);
  return quantityColumnNames.has(normalized);
}

function normalizeColumnName(columnName) {
  return String(columnName || "")
    .toLowerCase()
    .replace(/[\s_：:.-]+/g, "");
}

function parseQuantityValue(value, fallbackRawText, fallbackUnit = "") {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const withUnit = text.match(new RegExp(`^\\s*${numberPattern}\\s*${quantityUnitPattern}?\\s*$`, "i"));
  if (withUnit) {
    return {
      value: parseNumber(withUnit[1]),
      unit: normalizeUnit(withUnit[2] || fallbackUnit || ""),
      rawText: fallbackRawText
    };
  }

  const firstNumber = text.match(new RegExp(numberPattern));
  if (!firstNumber) {
    return null;
  }
  return {
    value: parseNumber(firstNumber[1]),
    unit: normalizeUnit(fallbackUnit || ""),
    rawText: fallbackRawText
  };
}

function findRowUnit(row) {
  for (const [columnName, value] of Object.entries(row || {})) {
    if (!unitColumnNames.has(normalizeColumnName(columnName))) {
      continue;
    }
    return String(value || "").trim();
  }
  return "";
}

function findQuantityMatches(text) {
  const matches = [];
  const occupiedRanges = [];
  const patterns = [
    new RegExp(`\\b(?:qty|quantity)\\s*[:：]?\\s*${numberPattern}\\s*${quantityUnitPattern}?\\b`, "gi"),
    new RegExp(`(?:数量)\\s*[:：]?\\s*${numberPattern}\\s*${quantityUnitPattern}?`, "gi"),
    new RegExp(`(?:采购|订购|需要)\\s*${numberPattern}\\s*${quantityUnitPattern}`, "gi"),
    new RegExp(`\\b${numberPattern}\\s*${quantityUnitPattern}\\b`, "gi")
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupiedRanges.some((range) => rangesOverlap(start, end, range.start, range.end))) {
        continue;
      }

      const rawText = match[0].trim();
      const parsed = rawText.match(new RegExp(`${numberPattern}\\s*${quantityUnitPattern}?`, "i"));
      if (!parsed) {
        continue;
      }
      occupiedRanges.push({ start, end });
      matches.push({
        value: parseNumber(parsed[1]),
        unit: normalizeUnit(parsed[2] || ""),
        rawText
      });
    }
  });

  return matches;
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function parseNumber(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function normalizeUnit(unit) {
  return String(unit || "").toLowerCase();
}

function getTextQuantityConfidence(blockType) {
  if (blockType === "table") {
    return 0.8;
  }
  if (blockType === "spreadsheet") {
    return 0.82;
  }
  if (blockType === "pdf_text" || blockType === "image_ocr") {
    return 0.68;
  }
  return 0.75;
}

function addUniqueQuantity(results, seen, item) {
  const key = [
    item.value,
    item.unit,
    item.raw_text,
    item.source,
    item.row_index || ""
  ].join("|");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  results.push(item);
}

function classifyBusinessType(extractedContent, contentBlocks) {
  const text = [
    extractedContent?.subject || "",
    collectBlockText(contentBlocks)
  ].join("\n");
  return classifyByRules(text, businessTypeRules, "没有足够信息判断邮件业务类型");
}

function classifyProductType(contentBlocks) {
  const text = collectBlockText(contentBlocks);
  const classified = classifyByRules(text, productTypeRules, "没有足够信息判断产品类别");
  const modelSignals = extractProductModels(contentBlocks).map((model) => model.value);

  if (modelSignals.length && (classified.code === "unknown" || isWeakEquipmentOnlyMatch(classified))) {
    return {
      code: "PT1",
      label: "标准品",
      confidence: 0.68,
      matched_keywords: modelSignals,
      reason: `内容中出现疑似明确产品型号：${modelSignals.join("、")}`
    };
  }

  if (classified.code === "PT1" && modelSignals.length) {
    return {
      ...classified,
      confidence: Math.max(classified.confidence, 0.76),
      matched_keywords: [...new Set([...classified.matched_keywords, ...modelSignals])],
      reason: `${classified.reason}；同时识别到疑似产品型号 ${modelSignals.join("、")}`
    };
  }

  return classified;
}

function collectBlockText(contentBlocks) {
  return contentBlocks
    .filter((block) => ["body_text", "table", "spreadsheet", "pdf_text", "image_ocr"].includes(block?.type))
    .map((block) => block.text || "")
    .join("\n");
}

function classifyByRules(text, rules, unknownReason) {
  const normalized = String(text || "").toLowerCase();
  const scored = rules.map((rule) => {
    const matched = rule.keywords.filter((keyword) => keywordMatches(normalized, keyword));
    const score = matched.reduce((sum, keyword) => sum + keywordWeight(keyword), 0);
    return { rule, matched, score };
  }).sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best || !best.matched.length) {
    return {
      code: "unknown",
      label: "未知",
      confidence: 0,
      matched_keywords: [],
      reason: unknownReason
    };
  }

  return {
    code: best.rule.code,
    label: best.rule.label,
    confidence: calculateClassificationConfidence(best.score, best.matched.length),
    matched_keywords: best.matched,
    reason: `${best.rule.reason}：${best.matched.join("、")}`
  };
}

function keywordMatches(normalizedText, keyword) {
  const normalizedKeyword = keyword.toLowerCase();
  if (normalizedKeyword === "设备") {
    return hasChineseKeywordOutsideCompanyName(normalizedText, normalizedKeyword);
  }
  return normalizedText.includes(normalizedKeyword);
}

function hasChineseKeywordOutsideCompanyName(text, keyword) {
  let index = text.indexOf(keyword);
  while (index >= 0) {
    const context = text.slice(index, index + 12);
    if (!/设备(?:股份|有限|公司)/.test(context)) {
      return true;
    }
    index = text.indexOf(keyword, index + keyword.length);
  }
  return false;
}

function findStandardModelSignals(text) {
  const matches = String(text || "").match(/\b[A-Z]{2,}[A-Z0-9]*(?:[.-][A-Z0-9]+){1,}(?:[-_/][A-Z0-9]+)*\b/g) || [];
  return [...new Set(matches)].slice(0, 5);
}

function extractProductModels(contentBlocks) {
  const results = [];
  const seen = new Set();

  for (const block of contentBlocks) {
    if (["table", "spreadsheet", "image_ocr"].includes(block?.type) && Array.isArray(block?.rows)) {
      extractModelsFromRows(block).forEach((model) => addUniqueModel(results, seen, model));
    }
  }

  for (const block of contentBlocks) {
    if (!["body_text", "table", "spreadsheet", "pdf_text", "image_ocr"].includes(block?.type)) {
      continue;
    }
    if (block?.type === "image_ocr" && Array.isArray(block?.rows) && block.rows.length) {
      continue;
    }
    extractModelsFromText(block).forEach((model) => addUniqueModel(results, seen, model));
  }

  return results.sort((left, right) => right.confidence - left.confidence).slice(0, 10);
}

function extractModelsFromRows(block) {
  const rows = Array.isArray(block?.rows) ? block.rows : [];
  const models = [];
  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object") {
      return;
    }

    Object.entries(row).forEach(([columnName, value]) => {
      if (!isModelColumn(columnName)) {
        return;
      }
      const model = normalizeModelValue(value);
      if (!model) {
        return;
      }
      models.push({
        value: model,
        raw_text: `${columnName}: ${value}`,
        source: block.source || block.metadata?.filename || "content_block",
        content_block_type: block.type,
        row_index: rowIndex + 1,
        confidence: block.type === "spreadsheet" ? 0.96 : 0.94
      });
    });
  });
  return models;
}

function extractModelsFromText(block) {
  const text = String(block?.text || "");
  const source = block.source || block.metadata?.filename || "content_block";
  const confidence = block.type === "pdf_text" || block.type === "image_ocr" ? 0.7 : 0.78;
  const models = [];
  const contextPatterns = [
    /\b(?:model(?:\s*no\.?)?|item\s*no\.?|part\s*number|sku)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,40})/gi,
    /(?:型号|货号|料号|产品型号)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,40})/gi
  ];

  contextPatterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text))) {
      const model = normalizeModelValue(match[1]);
      if (!model) {
        continue;
      }
      models.push({
        value: model,
        raw_text: match[0].trim(),
        source,
        content_block_type: block.type,
        confidence
      });
    }
  });

  findStandardModelSignals(text).forEach((model) => {
    models.push({
      value: model,
      raw_text: model,
      source,
      content_block_type: block.type,
      confidence: block.type === "pdf_text" || block.type === "image_ocr" ? 0.68 : 0.74
    });
  });

  return models;
}

function isModelColumn(columnName) {
  const normalized = normalizeColumnName(columnName);
  return ["model", "modelno", "itemno", "sku", "partnumber", "型号", "货号", "料号", "产品型号"].includes(normalized);
}

function normalizeModelValue(value) {
  const model = String(value ?? "")
    .trim()
    .replace(/^[：:#\-\s]+|[，。.,;；\s]+$/g, "");
  if (!model || model.length < 2 || /^\d+$/.test(model)) {
    return "";
  }
  return model;
}

function addUniqueModel(results, seen, model) {
  const key = `${model.value}|${model.source}|${model.row_index || ""}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  results.push(model);
}

function isWeakEquipmentOnlyMatch(classified) {
  return classified.code === "PT4"
    && classified.matched_keywords.length === 1
    && classified.matched_keywords[0] === "设备";
}

function keywordWeight(keyword) {
  return String(keyword).length > 8 || /[\s]/.test(keyword) ? 2 : 1;
}

function calculateClassificationConfidence(score, matchedCount) {
  return Math.min(0.95, Number((0.5 + score * 0.1 + matchedCount * 0.04).toFixed(2)));
}

function collectWarnings(contentBlocks) {
  return contentBlocks
    .filter((block) => block?.type === "attachment_error")
    .map((block) => ({
      source: block.source || block.metadata?.filename || "attachment",
      message: block.metadata?.error || "附件解析失败"
    }));
}
