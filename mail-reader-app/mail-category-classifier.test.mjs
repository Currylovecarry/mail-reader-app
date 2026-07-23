import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BUSINESS_TYPE_LABELS } from "./llm-order-draft-service.mjs";
import { businessTypeRules } from "./order-analysis-service.mjs";

const require = createRequire(import.meta.url);
const { categoryStyles, categorizeMail, classifyMail } = require("./mail-category-classifier.js");

const expectedBusinessTypes = {
  BT1: "初次询盘",
  BT2: "追单邮件",
  BT3: "样品申请",
  BT4: "投诉反馈",
  BT5: "合作咨询",
  BT6: "售后凭证"
};

Object.entries(expectedBusinessTypes).forEach(([code, label]) => {
  assert.equal(categoryStyles[code]?.label, label, `前端标签 ${code} 不得偏离业务定义`);
  assert.equal(BUSINESS_TYPE_LABELS[code], label, `LLM 标签 ${code} 不得偏离业务定义`);
  assert.equal(
    businessTypeRules.find((item) => item.code === code)?.label,
    label,
    `基础规则 ${code} 不得偏离业务定义`
  );
});

const cases = [
  {
    expected: "BT1",
    mail: {
      subject: "我司项目预计有如下物料需求，请协助提供报价、交期",
      body: ["附件为采购物料清单，请报 EXW 价格。"]
    }
  },
  {
    expected: "BT2",
    mail: {
      subject: "跟进上次报价",
      body: ["请问目前进展如何？烦请确认预计交期。"]
    }
  },
  {
    expected: "BT3",
    mail: {
      subject: "样品申请",
      body: ["请安排寄送两件样品用于 evaluation。"]
    }
  },
  {
    expected: "BT4",
    mail: {
      subject: "设备故障投诉",
      body: ["产品无法使用，烦请处理质量问题。"]
    }
  },
  {
    expected: "BT5",
    mail: {
      subject: "区域代理合作咨询",
      body: ["我司希望成为贵司经销商。"]
    }
  },
  {
    expected: "BT6",
    mail: {
      subject: "来自 Apple 苏州 的维修收据",
      sender: "Apple Store <suzhou@email.apple.com>",
      attachments: [{ name: "Sale_Email_Receipt.pdf" }]
    }
  },
  {
    expected: "transaction",
    mail: {
      subject: "京东已收到您的订单【3554460004】",
      body: ["可随时关注订单状态。"]
    }
  },
  {
    expected: "marketing",
    mail: {
      subject: "Steam Summer Sale on now",
      sender: "Steam <noreply@steampowered.com>",
      body: ["Recommended deals just for you."]
    }
  },
  {
    expected: "notification",
    mail: {
      subject: "连接到 Microsoft 帐户的新应用",
      sender: "Microsoft 帐户团队 <account-security-noreply@accountprotection.microsoft.com>"
    }
  },
  {
    expected: "other",
    mail: {
      subject: "周会资料",
      body: ["请查收。"]
    }
  }
];

cases.forEach(({ mail, expected }) => {
  assert.equal(categorizeMail(mail), expected, mail.subject);
});

const initialInquiry = classifyMail(cases[0].mail);
assert.ok(initialInquiry.score > 0);
assert.ok(initialInquiry.evidence.subjectHits > 0);

console.log("mail-category-classifier test passed");
