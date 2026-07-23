import assert from "node:assert/strict";
import { analyzeOrderContent } from "./order-analysis-service.mjs";

const result = analyzeOrderContent({
  content_blocks: [{
    type: "image_ocr",
    source: "material-list.jpg",
    confidence: 0.91,
    text: "PART NUMBER MATERIAL QTY.\nGN 425.1 NI 12 160 GS 2",
    rows: [{
      "PART NUMBER": "GN 425.1 NI 12 160 GS",
      MATERIAL: "",
      "QTY.": "2"
    }]
  }]
});

assert.deepEqual(result.product_models.map((item) => item.value), ["GN 425.1 NI 12 160 GS"]);
assert.deepEqual(result.quantities.map((item) => item.value), [2]);
assert.equal(result.quantities[0].row_index, 1);

const spacedGnModels = analyzeOrderContent({
  content_blocks: [{
    type: "body_text",
    source: "mail_body",
    text: [
      "GN 115-VDE-18-NI ，数量220",
      "GN 675-50-M8 ，数量50"
    ].join("\n")
  }]
});

assert.deepEqual(
  spacedGnModels.product_models.map((item) => item.value),
  ["GN 115-VDE-18-NI", "GN 675-50-M8"]
);
assert.deepEqual(spacedGnModels.quantities.map((item) => item.value), [220, 50]);

const imageTextFallback = analyzeOrderContent({
  content_blocks: [{
    type: "image_ocr",
    source: "product-page.jpg",
    text: [
      "型号 HCK.381-SST-M12-FKM-GL-P",
      "HCK.381-SST-M12-FKM-GL-P",
      "ALT-200",
      "数量 1 加入购物车"
    ].join("\n"),
    rows: [{
      型号: "HCK.381-SST-M12-FKM-GL-P",
      其他: ""
    }]
  }]
});

assert.deepEqual(
  imageTextFallback.product_models.map((item) => item.value),
  ["HCK.381-SST-M12-FKM-GL-P", "ALT-200"]
);
assert.deepEqual(imageTextFallback.quantities, []);

const softwareTestingMail = analyzeOrderContent({
  subject: "软件开发/软件测试岗位邀请",
  content_blocks: [{
    type: "body_text",
    source: "mail_body",
    text: "邀请投递软件测试岗位，点击查看职位详情。"
  }]
});
assert.notEqual(softwareTestingMail.business_type.code, "BT3");

const followUpMail = analyzeOrderContent({
  subject: "跟进上次报价",
  content_blocks: [{
    type: "body_text",
    source: "mail_body",
    text: "请问之前询价的产品是否有更新？我们仍在等待回复。"
  }]
});
assert.equal(followUpMail.business_type.code, "BT2");
assert.equal(followUpMail.business_type.label, "追单邮件");

const transactionalFooterMail = analyzeOrderContent({
  subject: "京东已收到您的订单",
  content_blocks: [{
    type: "body_text",
    source: "mail_body",
    text: "订单已确认，可前往页面查看详情。退订投诉"
  }]
});
assert.notEqual(transactionalFooterMail.business_type.code, "BT4");

console.log("order-analysis-service test passed");
