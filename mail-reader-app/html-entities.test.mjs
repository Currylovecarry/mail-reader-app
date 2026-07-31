import assert from "node:assert/strict";
import test from "node:test";

import { extractEmailContent } from "./content-extractor.mjs";
import { decodeHtmlEntities } from "./html-entities.mjs";

test("还原常见邮件 HTML 实体和数字实体", () => {
  assert.equal(
    decodeHtmlEntities("测试&nbsp;|&nbsp;标准件采购部 &lt;a&gt; &#62; &#x3E;"),
    "测试 | 标准件采购部 <a> > >"
  );
});

test("兼容被重复转义的邮件实体", () => {
  assert.equal(
    decodeHtmlEntities("发件人：钱晓祥 &amp;lt;qian@example.com&amp;gt;"),
    "发件人：钱晓祥 <qian@example.com>"
  );
});

test("历史纯文本邮件进入智能识别前会清洗实体", async () => {
  const extracted = await extractEmailContent({
    id: "entity-test",
    subject: "询价",
    sender: "采购部",
    textBody: "GN 675-50-M8&nbsp;，数量15个\n发件人：钱晓祥 &lt;qian@example.com&gt;",
    body: [],
    attachments: []
  });

  assert.equal(
    extracted.content_blocks[0].text,
    "GN 675-50-M8 ，数量15个\n发件人：钱晓祥 <qian@example.com>"
  );
});
