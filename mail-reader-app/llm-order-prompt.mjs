const MAX_BLOCK_TEXT_LENGTH = 2400;
const MAX_BLOCK_ROWS = 20;

export function buildOrderDraftPrompt(extractedContent, structuredHints = {}) {
  const promptPayload = {
    email: {
      email_id: extractedContent?.email_id || "",
      subject: extractedContent?.subject || "",
      from: extractedContent?.from || "",
      received_at: extractedContent?.received_at || ""
    },
    structured_hints: structuredHints,
    content_blocks: sanitizeContentBlocks(extractedContent?.content_blocks || [])
  };

  return {
    system: [
      "你是一个 Order Parser。",
      "你的任务是基于 content_blocks 自动识别订单结构化信息，并输出严格 JSON。",
      "你只能基于提供的 subject、sender、body_text、table rows、spreadsheet rows、pdf_text、image_ocr、structured_hints 做判断。",
      "不要生成自然语言段落，不要输出 Markdown，不要输出解释文字或代码块。",
      "不要编造任何不存在的信息，不要猜测原始附件内容，不要假设客户意图。",
      "如果字段没有明确证据，请返回空字符串、null 或空数组，并把字段名加入 missing_fields。",
      "对数量、单位、型号、产品名等字段，spreadsheet/table 的结构化 rows 优先级最高，不允许改写明显的结构化值。",
      "image_ocr 可能来自网页截图；只有存在明确采购语义并且型号与数量在同一证据行绑定时，才可把数字作为采购数量。",
      "购物车数量、数量选择器、加入购物车控件、商品代码、价格、电话、日期和页面导航数字都不是采购数量。",
      "如果 image_ocr rows 的表头含义不明确或无法映射到型号、产品、数量等字段，应忽略 rows 并改用该块的完整 text。",
      "structured_hints 只是辅助线索，不是最终答案；你必须自行结合 content_blocks 做结构化识别。",
      "每个产品都必须包含 evidence，尤其要覆盖 product_model、product_name、quantity、unit。",
      "evidence 至少包含 source、content_block_type、row_index 或 block_index、raw_text。",
      "如果 evidence 不充分，请降低 confidence，并在 warnings 中说明。"
    ].join(" "),
    user: [
      "请基于下面的数据识别并输出 order_draft JSON。",
      "business_type 只能是 BT1-BT5 之一：BT1 初次询盘，BT2 追单邮件，BT3 样品申请，BT4 投诉反馈，BT5 合作咨询。",
      "product_type 只能是 PT1-PT4 之一：PT1 标准品，PT2 定制品，PT3 备件，PT4 整机设备。",
      "你需要自动识别 business_type、product_type、products、requirements、missing_fields、warnings、evidence。",
      "requirements 至少包括 delivery_terms、delivery_date、destination、payment_terms、contact_person、phone、company、project_name。",
      "如果 table/spreadsheet rows 中已经有明确 quantity、unit、product_model、product_name，请优先使用这些结构化值。",
      "如果你的判断与 structured_hints 冲突，不要覆盖明显的结构化值，并在 warnings 中加入冲突说明。",
      "只输出 JSON。不要输出任何 JSON 之外的内容。",
      "返回顶层 JSON 必须包含：status, order_draft。",
      "status 固定为 success。",
      "order_draft 必须包含：email_id, business_type, product_type, products, requirements, missing_fields, warnings, evidence。",
      "evidence 顶层必须包含：business_type, product_type, requirements。",
      "products[].evidence 必须包含：source, content_block_type, raw_text，并尽量提供 row_index 与 block_index。",
      "下面是输入数据 JSON：",
      JSON.stringify(promptPayload, null, 2)
    ].join("\n")
  };
}

function sanitizeContentBlocks(contentBlocks) {
  return (Array.isArray(contentBlocks) ? contentBlocks : []).map((block, blockIndex) => {
    const sanitized = {
      block_index: blockIndex,
      type: block?.type || "",
      source: block?.source || "",
      confidence: Number(block?.confidence) || 0,
      metadata: sanitizeMetadata(block?.metadata || {})
    };

    if (block?.text) {
      sanitized.text = String(block.text).slice(0, MAX_BLOCK_TEXT_LENGTH);
    }

    if (Array.isArray(block?.rows) && block.rows.length) {
      sanitized.rows = block.rows.slice(0, MAX_BLOCK_ROWS);
    }

    return sanitized;
  });
}

function sanitizeMetadata(metadata) {
  const allowedKeys = [
    "filename",
    "sheet_name",
    "row_count",
    "column_count",
    "parser",
    "status",
    "header_detected",
    "header_row_index",
    "data_start_row_index",
    "header_confidence",
    "table_layout_detected",
    "ocr_page_segmentation_mode",
    "sheet_metadata",
    "mime_type",
    "size",
    "storage_path",
    "error"
  ];

  return allowedKeys.reduce((result, key) => {
    if (metadata[key] !== undefined) {
      result[key] = metadata[key];
    }
    return result;
  }, {});
}
