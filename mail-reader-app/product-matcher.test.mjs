import assert from "node:assert/strict";
import {
  compareSpec,
  matchProduct,
  parseSpecFromCode,
  partialRatio
} from "./product-matcher.mjs";

const catalog = [
  { id: 1, product_code: "GN 675-50-M8", normalized_code: "GN675-50-M8", active: 1 },
  { id: 2, product_code: "GN 675-60-M8", normalized_code: "GN675-60-M8", active: 1 },
  { id: 3, product_code: "GN 675-50-M12", normalized_code: "GN675-50-M12", active: 1 },
  { id: 4, product_code: "A-2024-88", normalized_code: "A-2024-88", active: 1 }
];

const exact = matchProduct({ model_normalized: "GN675-50-M8" }, catalog);
assert.equal(exact.match_status, "exact_match");
assert.equal(exact.selected_product_id, 1);
assert.equal(exact.need_manual_review, false);
assert.equal(exact.candidates[0].final_score, 100);

const sizeConflict = matchProduct({ model_normalized: "GN675-55-M8" }, catalog);
assert.equal(sizeConflict.match_status, "fuzzy_match");
assert.equal(sizeConflict.candidates[0].product_id, 1);
assert.match(sizeConflict.spec_warning, /size_conflict/);
assert.equal(sizeConflict.need_manual_review, true);

const threadConflict = matchProduct({ model_normalized: "GN675-50-M10" }, catalog);
assert.equal(threadConflict.match_status, "fuzzy_match");
assert.match(threadConflict.spec_warning, /thread_conflict/);

const noMatch = matchProduct({ model_normalized: "ZZZ-999-UNKNOWN" }, catalog);
assert.equal(noMatch.match_status, "no_match");
assert.equal(noMatch.need_manual_review, true);

const empty = matchProduct({ model_normalized: "" }, catalog);
assert.equal(empty.match_status, "no_match");
assert.equal(empty.review_reason, "empty_model");

assert.equal(partialRatio("GN675-50-M8", "GN675-50-M8"), 100);
assert.ok(partialRatio("GN675-55-M8", "GN675-50-M8") >= 90);

const parsed = parseSpecFromCode("GN675-50-M8");
assert.deepEqual(
  { series: parsed.series, size: parsed.size, thread: parsed.thread },
  { series: "GN675", size: "50", thread: "M8" }
);
assert.deepEqual(
  compareSpec(
    { ...parsed, thread: "M10" },
    parsed
  ),
  { spec_score: 60, spec_warning: "thread_conflict" }
);

console.log("product-matcher test passed");
