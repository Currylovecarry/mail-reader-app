import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const attachmentRoot = path.join(__dirname, "imported-attachments");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_TEXT_LENGTH = 20000;

const pdfExtensions = new Set([".pdf"]);
const pdfMimeTypes = new Set(["application/pdf"]);

export function isPdfAttachment(attachment) {
  const extension = path.extname(attachment?.name || "").toLowerCase();
  const mimeType = String(attachment?.type || "").toLowerCase();
  return pdfExtensions.has(extension) || pdfMimeTypes.has(mimeType);
}

export async function extractPdfBlocks(attachment) {
  if (!isPdfAttachment(attachment)) {
    return [];
  }

  const filename = attachment.name || "attachment";
  console.info(`[pdf-extractor] detected filename="${filename}"`);

  try {
    const filePath = resolveAttachmentPath(attachment);
    if (!filePath) {
      throw new Error("附件没有可读取的本地存储路径");
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`附件超过 ${MAX_FILE_SIZE} 字节限制`);
    }

    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: buffer });

    try {
      const result = await parser.getText({ first: MAX_PAGES });
      const pageCount = Number(result.total) || 0;
      const pages = Array.isArray(result.pages) ? result.pages : [];
      const parsedPages = pages.map((page) => page.num).filter(Number.isFinite);
      const rawText = pages
        .map((page) => normalizePdfText(page.text))
        .filter(Boolean)
        .join("\n\n");
      const limited = limitText(rawText);
      const truncated = pageCount > MAX_PAGES || limited.truncated;

      console.info(
        `[pdf-extractor] pages filename="${filename}" page_count=${pageCount} parsed_pages=${pages.length}`
      );

      if (!limited.text) {
        console.info(`[pdf-extractor] needs_ocr filename="${filename}" page_count=${pageCount}`);
        return [createNeedsOcrBlock(filename, pageCount)];
      }

      if (truncated) {
        console.info(
          `[pdf-extractor] truncated filename="${filename}" page_count=${pageCount} text_length=${rawText.length}`
        );
      }
      console.info(`[pdf-extractor] parsed filename="${filename}" text_length=${limited.text.length}`);

      return [
        {
          type: "pdf_text",
          source: filename,
          text: limited.text,
          confidence: 0.9,
          metadata: {
            filename,
            page_count: pageCount,
            parser: "pdf",
            status: "parsed",
            parsed_pages: parsedPages,
            max_pages: MAX_PAGES,
            ...(truncated ? { truncated: true } : {})
          }
        }
      ];
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    console.warn(`[pdf-extractor] failed filename="${filename}" error="${error.message || error}"`);
    return [createErrorBlock(attachment, error)];
  }
}

function resolveAttachmentPath(attachment) {
  const storagePath = attachment.filePath || attachment.previewPath || attachment.downloadUrl || "";
  if (!storagePath) {
    return "";
  }

  if (path.isAbsolute(storagePath) && !storagePath.startsWith("/attachments/")) {
    return path.normalize(storagePath);
  }

  if (storagePath.startsWith("/attachments/")) {
    const relativePath = decodeURIComponent(storagePath.replace("/attachments/", ""));
    return safeAttachmentPath(relativePath);
  }

  if (storagePath.startsWith("./imported-attachments/")) {
    return path.resolve(__dirname, storagePath.slice(2));
  }

  return path.resolve(__dirname, storagePath);
}

function safeAttachmentPath(relativePath) {
  const targetPath = path.resolve(attachmentRoot, relativePath);
  if (!targetPath.startsWith(attachmentRoot)) {
    throw new Error("附件路径非法");
  }
  return targetPath;
}

function normalizePdfText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function limitText(text) {
  if (text.length <= MAX_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_TEXT_LENGTH), truncated: true };
}

function createNeedsOcrBlock(filename, pageCount) {
  return {
    type: "pdf_text",
    source: filename,
    text: "",
    confidence: 0,
    metadata: {
      filename,
      page_count: pageCount,
      parser: "pdf",
      status: "needs_ocr",
      reason: "No extractable text found"
    }
  };
}

function createErrorBlock(attachment, error) {
  return {
    type: "attachment_error",
    source: attachment.name || "attachment",
    text: "",
    confidence: 0,
    metadata: {
      filename: attachment.name || "attachment",
      parser: "pdf",
      status: "parse_failed",
      error: error?.message || "解析失败"
    }
  };
}
