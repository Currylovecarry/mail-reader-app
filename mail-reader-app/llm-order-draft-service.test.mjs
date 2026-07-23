import assert from "node:assert/strict";
import { generateOrderDraft } from "./llm-order-draft-service.mjs";

const extractedContent = {
  email_id: "mail_test_001",
  subject: "案例邮件：询价清单",
  from: "customer@example.com",
  received_at: "2026-07-04T10:00:00Z",
  content_blocks: [
    {
      type: "body_text",
      source: "email_body",
      text: "你好，这是一份询价清单，请提供报价。项目：苏州自动化改造项目。",
      confidence: 1,
      metadata: {}
    },
    {
      type: "spreadsheet",
      source: "inquiry-material-list.xlsx#询价清单",
      text: "",
      confidence: 0.95,
      rows: [
        {
          "序号": "1",
          "产品型号": "GN 5334.4-80-M10",
          "产品名称": "球形把手",
          "数量": "30",
          "单位": "个",
          "备注": "黑色款"
        },
        {
          "序号": "2",
          "产品型号": "GN 115.7-42-B10",
          "产品名称": "门锁",
          "数量": "12",
          "单位": "套",
          "备注": "含钥匙"
        }
      ],
      metadata: {
        sheet_name: "询价清单",
        header_row_index: 6,
        data_start_row_index: 7,
        header_confidence: "high",
        sheet_metadata: {
          "项目": "苏州自动化改造项目",
          "客户联系人": "李敏",
          "联系电话": "13800001234",
          "报价条款": "EXW"
        }
      }
    }
  ]
};

const mockLlmResponse = {
  status: "success",
  order_draft: {
    email_id: "mail_test_001",
    business_type: {
      code: "BT1",
      label: "初次询盘",
      confidence: 0.86,
      reason: "邮件请求报价，并包含产品清单"
    },
    product_type: {
      code: "PT1",
      label: "标准品",
      confidence: 0.82,
      reason: "产品清单中存在明确产品型号"
    },
    products: [
      {
        line_no: 1,
        product_model: "GN 5334.4-80-M10",
        product_name: "球形把手",
        quantity: 999,
        unit: "个",
        specifications: "",
        remarks: "黑色款",
        confidence: 0.9,
        evidence: {
          source: "inquiry-material-list.xlsx#询价清单",
          content_block_type: "spreadsheet",
          block_index: 1,
          row_index: 1,
          raw_text: "GN 5334.4-80-M10 | 球形把手 | 30 | 个 | 黑色款"
        }
      }
    ],
    requirements: {
      delivery_terms: "EXW",
      delivery_date: "",
      destination: "",
      payment_terms: "",
      contact_person: "李敏",
      phone: "13800001234",
      company: "",
      project_name: "苏州自动化改造项目"
    },
    missing_fields: ["delivery_date", "destination", "payment_terms"],
    warnings: [],
    evidence: {
      business_type: {
        source: "email_body",
        content_block_type: "body_text",
        block_index: 0,
        row_index: null,
        raw_text: "这是一份询价清单，请提供报价。"
      },
      product_type: {
        source: "inquiry-material-list.xlsx#询价清单",
        content_block_type: "spreadsheet",
        block_index: 1,
        row_index: 1,
        raw_text: "GN 5334.4-80-M10 | 球形把手 | 30 | 个 | 黑色款"
      },
      requirements: {
        delivery_terms: {
          source: "inquiry-material-list.xlsx#询价清单",
          content_block_type: "spreadsheet",
          block_index: 1,
          row_index: null,
          raw_text: "报价条款: EXW"
        },
        contact_person: {
          source: "inquiry-material-list.xlsx#询价清单",
          content_block_type: "spreadsheet",
          block_index: 1,
          row_index: null,
          raw_text: "客户联系人: 李敏"
        },
        phone: {
          source: "inquiry-material-list.xlsx#询价清单",
          content_block_type: "spreadsheet",
          block_index: 1,
          row_index: null,
          raw_text: "联系电话: 13800001234"
        },
        project_name: {
          source: "inquiry-material-list.xlsx#询价清单",
          content_block_type: "spreadsheet",
          block_index: 1,
          row_index: null,
          raw_text: "项目: 苏州自动化改造项目"
        }
      }
    }
  }
};

const result = await generateOrderDraft(extractedContent, {
  invokeLlm: async () => JSON.stringify(mockLlmResponse)
});

assert.equal(result.status, "success");
assert.ok(result.plain_summary.includes("这是一封初次询盘邮件"));
assert.ok(result.plain_summary.includes("球形把手"));
assert.ok(result.plain_summary.includes("数量：30 个"));
assert.ok(result.plain_summary.includes("报价条款为 EXW"));
assert.ok(Array.isArray(result.order_draft.products));
assert.equal(result.order_draft.products.length, 2);
assert.equal(result.order_draft.products[0].quantity, 30);
assert.equal(result.order_draft.products[0].evidence.row_index, 1);
assert.equal(result.order_draft.requirements.delivery_terms, "EXW");
assert.equal(result.order_draft.requirements.contact_person, "李敏");
assert.ok(result.order_draft.missing_fields.includes("delivery_date"));
assert.ok(result.order_draft.warnings.includes("LLM quantity differs from structured quantity"));

let fastPathLlmCalls = 0;
const fastPathResult = await generateOrderDraft({
  ...extractedContent,
  email_id: "mail_fast_path_001",
  content_blocks: extractedContent.content_blocks.map((block) => block.type === "spreadsheet"
    ? {
        ...block,
        text: [
          "| 序号 | 产品型号 | 产品名称 | 数量 | 单位 |",
          "| --- | --- | --- | --- | --- |",
          "| 1 | GN 5334.4-80-M10 | 球形把手 | 30 | 个 |",
          "| 2 | GN 115.7-42-B10 | 门锁 | 12 | 套 |"
        ].join("\n")
      }
    : block)
}, {
  invokeLlm: async () => {
    fastPathLlmCalls += 1;
    throw new Error("高置信度结构化邮件不应调用 LLM");
  }
});

assert.equal(fastPathLlmCalls, 0);
assert.equal(fastPathResult.status, "success");
assert.equal(fastPathResult.provider, "local_structured");
assert.equal(fastPathResult.processing.mode, "structured_fast_path");
assert.equal(fastPathResult.processing.llm_called, false);
assert.equal(fastPathResult.order_draft.products.length, 2);
assert.equal(fastPathResult.order_draft.products[0].quantity, 30);

const stringClassificationResult = await generateOrderDraft({
  email_id: "mail_string_classification",
  subject: "设备故障投诉",
  from: "customer@example.com",
  content_blocks: [
    {
      type: "body_text",
      source: "email_body",
      text: "客户投诉：设备故障且不能用，请尽快处理。",
      confidence: 1,
      metadata: {}
    }
  ]
}, {
  invokeLlm: async () => JSON.stringify({
    status: "success",
    order_draft: {
      email_id: "mail_string_classification",
      business_type: "BT4",
      product_type: "PT4",
      products: [
        {
          line_no: 1,
          product_model: "MAC-100",
          product_name: "自动化设备",
          quantity: 1,
          unit: "台",
          specifications: "",
          remarks: "故障",
          confidence: 0.86,
          evidence: {
            source: "email_body",
            content_block_type: "body_text",
            block_index: 0,
            row_index: null,
            raw_text: "设备故障且不能用"
          }
        }
      ],
      requirements: {},
      warnings: [],
      evidence: {}
    }
  })
});

assert.equal(stringClassificationResult.status, "success");
assert.equal(stringClassificationResult.order_draft.business_type.code, "BT4");
assert.equal(stringClassificationResult.order_draft.business_type.label, "投诉反馈");
assert.equal(stringClassificationResult.order_draft.product_type.code, "PT4");

const appleReceiptContent = {
  email_id: "mail_apple_repair_receipt",
  subject: "Apple 维修收据",
  from: "apple@example.com",
  content_blocks: [
    {
      type: "pdf_text",
      source: "Sale_Email_Receipt_20260720R6881186609_zh_CN.pdf",
      text: [
        "Apple 维修收据",
        "维修 ID: R6881186609",
        "维修配件 IPAD PRO 11,3G,WIFI,128GB, SILVER-CH ¥0.00",
        "部件号: CE661-20074",
        "IPAD 维修费 ¥948.00",
        "部件号: SHXG2Z/A",
        "付款方式：支付宝",
        "支付金额：¥948.00"
      ].join("\n"),
      confidence: 0.98,
      metadata: { filename: "Sale_Email_Receipt_20260720R6881186609_zh_CN.pdf" }
    }
  ]
};

const appleReceiptResult = await generateOrderDraft(appleReceiptContent, {
  invokeLlm: async () => JSON.stringify({
    status: "success",
    order_draft: {
      email_id: "mail_apple_repair_receipt",
      business_type: "BT6",
      product_type: { code: "PT3", label: "备件", confidence: 0.9, reason: "包含维修配件" },
      products: [],
      requirements: {},
      warnings: [],
      evidence: {}
    }
  })
});

assert.equal(appleReceiptResult.status, "success");
assert.equal(appleReceiptResult.order_draft.business_type.code, "BT6");
assert.equal(appleReceiptResult.order_draft.business_type.label, "售后凭证");
assert.equal(appleReceiptResult.order_draft.products.length, 2);
assert.deepEqual(
  appleReceiptResult.order_draft.products.map((product) => product.product_model),
  ["CE661-20074", "SHXG2Z/A"]
);
assert.equal(
  appleReceiptResult.order_draft.products[0].product_name,
  "维修配件 IPAD PRO 11,3G,WIFI,128GB, SILVER-CH"
);
assert.equal(appleReceiptResult.order_draft.products[1].product_name, "IPAD 维修费");

const appleReceiptFallbackResult = await generateOrderDraft(appleReceiptContent, {
  invokeLlm: async () => "not valid json"
});

assert.equal(appleReceiptFallbackResult.status, "partial_success");
assert.equal(appleReceiptFallbackResult.order_draft.business_type.code, "BT6");
assert.deepEqual(
  appleReceiptFallbackResult.order_draft.products.map((product) => product.product_model),
  ["CE661-20074", "SHXG2Z/A"]
);

const partialResult = await generateOrderDraft({
  email_id: "mail_partial_success",
  subject: "产品资料",
  from: "customer@example.com",
  content_blocks: [
    {
      type: "spreadsheet",
      source: "products.xlsx#Sheet1",
      text: "",
      rows: [{ "产品型号": "AX-100", "产品名称": "电机组件" }],
      confidence: 0.95,
      metadata: {}
    }
  ]
}, {
  invokeLlm: async () => JSON.stringify({
    status: "success",
    order_draft: {
      email_id: "mail_partial_success",
      business_type: "not-a-valid-business-type",
      product_type: "PT3",
      products: [],
      requirements: {},
      warnings: [],
      evidence: {}
    }
  })
});

assert.equal(partialResult.status, "partial_success");
assert.equal(partialResult.order_draft.business_type.code, "unknown");
assert.equal(partialResult.order_draft.products[0].product_model, "AX-100");
assert.equal(partialResult.error, "");
assert.ok(partialResult.partial_reasons.includes("业务类型待人工确认"));
assert.ok(partialResult.plain_summary.includes("业务类型还需要进一步确认"));

console.log("llm-order-draft-service test passed");
