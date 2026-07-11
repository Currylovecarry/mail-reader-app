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

console.log("order-analysis-service test passed");
