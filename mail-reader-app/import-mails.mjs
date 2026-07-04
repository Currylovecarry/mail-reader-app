import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importInbox, loadDotEnv } from "./mail-service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputFile = path.join(__dirname, "mail-data.js");

await loadDotEnv();

const alias = process.argv[2] || "";
const limit = Number(process.argv[3]) || undefined;
const force = process.argv.includes("--force");
const payload = await importInbox({ alias, limit, force });

await fs.writeFile(
  outputFile,
  `window.__IMPORTED_MAIL_DATA__ = ${JSON.stringify(payload, null, 2)};\n`,
  "utf8"
);

const log = payload.syncLog || {};
console.log(
  `已导入 ${payload.mails?.length || 0} 封邮件到 ${outputFile}，本次扫描 ${log.scanned || 0} 封，新增 ${log.added || 0} 封，覆盖 ${log.replaced || 0} 封，跳过重复 ${log.skipped || 0} 封，跳过过旧 ${log.skippedOld || 0} 封`
);
