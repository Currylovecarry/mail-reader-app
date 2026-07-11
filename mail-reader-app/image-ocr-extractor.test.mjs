import assert from "node:assert/strict";
import { extractTableRowsFromTsv, isTableLikeLayout, selectBestOcrResult } from "./image-ocr-extractor.mjs";

const tableTsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "1\t1\t0\t0\t0\t0\t0\t0\t1200\t300\t-1\t",
  "5\t1\t1\t1\t1\t1\t80\t40\t120\t20\t95\tPart",
  "5\t1\t1\t1\t1\t2\t600\t40\t100\t20\t95\tMaterial",
  "5\t1\t1\t1\t1\t3\t1000\t40\t80\t20\t95\tQry",
  "5\t1\t1\t1\t2\t1\t80\t100\t300\t20\t95\tGN-425.1",
  "5\t1\t1\t1\t2\t2\t1100\t100\t20\t20\t95\t2"
].join("\n");

const paragraphTsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "1\t1\t0\t0\t0\t0\t0\t0\t1200\t300\t-1\t",
  "5\t1\t1\t1\t1\t1\t80\t40\t80\t20\t95\tPlease",
  "5\t1\t1\t1\t1\t2\t170\t40\t60\t20\t95\tquote",
  "5\t1\t1\t1\t1\t3\t240\t40\t50\t20\t95\tthe",
  "5\t1\t1\t1\t2\t1\t80\t75\t60\t20\t95\titems",
  "5\t1\t1\t1\t2\t2\t150\t75\t40\t20\t95\tbelow"
].join("\n");

assert.equal(isTableLikeLayout(tableTsv), true);
assert.equal(isTableLikeLayout(paragraphTsv), false);
assert.deepEqual(
  extractTableRowsFromTsv(tableTsv, "Part Material Qty\nGN-425.1 2"),
  [{ Part: "GN-425.1", Material: "", Qty: "2" }]
);

const autoResult = { psm: "3", text: "PART NUMBER\nGN-425.1 2", confidence: 88 };
const singleColumnResult = { psm: "4", text: "PART NUMBER\nGN-425.1 2", confidence: 91 };
assert.equal(selectBestOcrResult(autoResult, singleColumnResult).psm, "4");

const incompleteSingleColumnResult = { psm: "4", text: "PART NUMBER", confidence: 99 };
assert.equal(selectBestOcrResult(autoResult, incompleteSingleColumnResult).psm, "3");

console.log("image-ocr-extractor test passed");
