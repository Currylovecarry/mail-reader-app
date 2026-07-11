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

console.log("llm-order-draft-service test passed");
