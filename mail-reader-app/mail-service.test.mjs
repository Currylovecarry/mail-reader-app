import assert from "node:assert/strict";
import test from "node:test";

import { countRetainedAddedMails } from "./mail-service.mjs";

function mail(id, time) {
  return {
    id,
    messageId: id,
    time
  };
}

test("新增数只统计最终保留下来的邮件", () => {
  const candidates = Array.from({ length: 139 }, (_, index) =>
    mail(`new-${index + 1}`, new Date(Date.UTC(2026, 0, index + 1)).toISOString())
  );
  const retained = candidates
    .sort((left, right) => new Date(right.time) - new Date(left.time))
    .slice(0, 50);

  assert.equal(countRetainedAddedMails(retained, new Set()), 50);
});

test("已保留邮件和同 messageId 覆盖邮件不重复计为新增", () => {
  const retained = [
    mail("new-mail", "2026-07-20T10:00:00.000Z"),
    mail("existing-mail", "2026-07-19T10:00:00.000Z")
  ];
  const previousKeys = new Set(["message:existing-mail"]);

  assert.equal(countRetainedAddedMails(retained, previousKeys), 1);
});
