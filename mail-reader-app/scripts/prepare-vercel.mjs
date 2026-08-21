import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const publicDirectory = path.join(appDirectory, "public");

await fs.mkdir(publicDirectory, { recursive: true });
const indexHtml = await fs.readFile(path.join(appDirectory, "index.html"), "utf8");
// Local mail-data.js may contain a developer's imported-mail snapshot. It must
// never be published with a multi-user deployment.
await fs.writeFile(
  path.join(publicDirectory, "index.html"),
  indexHtml.replace(/\s*<script src="\.\/mail-data\.js"><\/script>/, "")
);
await fs.copyFile(
  path.join(appDirectory, "mail-category-classifier.js"),
  path.join(publicDirectory, "mail-category-classifier.js")
);
