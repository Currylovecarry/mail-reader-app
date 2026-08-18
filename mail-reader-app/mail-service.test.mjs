import assert from "node:assert/strict";
import test from "node:test";
import { countRetainedAddedMails, normalizeMailboxConfig } from "./mail-service.mjs";

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

const config = normalizeMailboxConfig({
  email: "orders@example.com",
  imapHost: "imap.example.com",
  imapPort: "993",
  imapMailbox: "INBOX",
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: false,
  authCode: "app-password"
});

assert.equal(config.MAIL_MODE, "imap_smtp");
assert.equal(config.MAIL_EMAIL, "orders@example.com");
assert.equal(config.IMAP_PORT, "993");
assert.equal(config.IMAP_SECURE, "true");
assert.equal(config.SMTP_PORT, "465");
assert.equal(config.SMTP_SECURE, "false");
assert.equal(config.MAIL_AUTH_CODE, "app-password");

assert.throws(
  () => normalizeMailboxConfig({
    email: "invalid-email",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    authCode: "app-password"
  }),
  /邮箱地址格式不正确/
);

assert.throws(
  () => normalizeMailboxConfig({
    email: "orders@example.com",
    imapHost: "imap.example.com",
    imapPort: 0,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    authCode: "app-password"
  }),
  /IMAP 端口/
);

console.log("mail-service config test passed");
