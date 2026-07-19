import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "tesseract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const attachmentRoot = path.join(__dirname, "imported-attachments");
const tessdataPath = path.join(__dirname, "data", "tessdata");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_WIDTH = 6000;
const MAX_HEIGHT = 6000;
const MAX_PIXELS = 16 * 1000 * 1000;
const OCR_TIMEOUT_MS = 90 * 1000;
const PSM_AUTO = "3";
const PSM_SINGLE_COLUMN = "4";
const DEFAULT_OCR_LANGUAGES = ["eng", "chi_sim", "deu"];
const OCR_LANGUAGES = parseOcrLanguages(process.env.OCR_LANGUAGES);
const OCR_LANGUAGE_LABEL = OCR_LANGUAGES.join("+");
const ocrLanguagePackages = {
  eng: path.join(__dirname, "node_modules", "@tesseract.js-data", "eng", "4.0.0", "eng.traineddata.gz"),
  chi_sim: path.join(__dirname, "node_modules", "@tesseract.js-data", "chi_sim", "4.0.0", "chi_sim.traineddata.gz"),
  deu: path.join(__dirname, "node_modules", "@tesseract.js-data", "deu", "4.0.0", "deu.traineddata.gz")
};

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);

function parseOcrLanguages(value) {
  const languages = String(value || "")
    .split(/[+,]/)
    .map((language) => language.trim())
    .filter(Boolean);
  return languages.length ? languages : DEFAULT_OCR_LANGUAGES;
}

export function isImageAttachment(attachment) {
  const extension = path.extname(attachment?.name || "").toLowerCase();
  const mimeType = String(attachment?.type || "").toLowerCase();
  return imageExtensions.has(extension) || imageMimeTypes.has(mimeType);
}

export async function extractImageOcrBlocks(attachment) {
  if (!isImageAttachment(attachment)) {
    return [];
  }

  const filename = attachment.name || "attachment";
  const mimeType = attachment.type || "";
  console.info(`[image-ocr-extractor] detected filename="${filename}" language=${OCR_LANGUAGE_LABEL}`);

  try {
    const filePath = resolveAttachmentPath(attachment);
    if (!filePath) {
      throw new Error("附件没有可读取的本地存储路径");
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      console.info(`[image-ocr-extractor] skipped filename="${filename}" reason="Image file too large" size=${stat.size}`);
      return [createSkippedBlock(attachment, "Image file too large")];
    }

    const header = await readHeader(filePath);
    const dimensions = getImageDimensions(header);
    if (!dimensions) {
      console.info(`[image-ocr-extractor] skipped filename="${filename}" reason="Unable to determine image dimensions"`);
      return [createSkippedBlock(attachment, "Unable to determine image dimensions")];
    }

    if (exceedsDimensionLimit(dimensions)) {
      console.info(
        `[image-ocr-extractor] skipped filename="${filename}" reason="Image dimensions too large" width=${dimensions.width} height=${dimensions.height}`
      );
      return [createSkippedBlock(attachment, "Image dimensions too large", dimensions)];
    }

    const result = await runOcrWithTimeout(filePath);
    const text = normalizeOcrText(result.text);
    const confidence = normalizeConfidence(result.confidence);
    const rows = result.tableRows || [];

    if (!text) {
      console.info(
        `[image-ocr-extractor] no_text_found filename="${filename}" confidence=${confidence} text_length=0`
      );
      return [createNoTextBlock(attachment, dimensions)];
    }

    console.info(
      `[image-ocr-extractor] parsed filename="${filename}" confidence=${confidence} text_length=${text.length}`
    );

    return [
      {
        type: "image_ocr",
        source: filename,
        text,
        ...(rows.length ? { rows } : {}),
        confidence,
        metadata: {
          filename,
          mime_type: mimeType,
          parser: "ocr",
          ocr_engine: "tesseract.js",
          ocr_page_segmentation_mode: result.psm,
          table_layout_detected: result.tableLayoutDetected,
          ...(rows.length ? { header_detected: true, row_count: rows.length, column_count: Object.keys(rows[0]).length } : {}),
          language: OCR_LANGUAGE_LABEL,
          languages: OCR_LANGUAGES,
          status: "parsed",
          width: dimensions.width,
          height: dimensions.height
        }
      }
    ];
  } catch (error) {
    const message = error?.message || "解析失败";
    console.warn(`[image-ocr-extractor] failed filename="${filename}" error="${message}"`);
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

async function readHeader(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function getImageDimensions(buffer) {
  return getPngDimensions(buffer)
    || getJpegDimensions(buffer)
    || getWebpDimensions(buffer)
    || getBmpDimensions(buffer);
}

function getPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function getJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      return null;
    }

    if (isJpegStartOfFrame(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  return null;
}

function isJpegStartOfFrame(marker) {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ].includes(marker);
}

function getWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }

  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (format === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  if (format === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return null;
}

function getBmpDimensions(buffer) {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") {
    return null;
  }
  return {
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22))
  };
}

function exceedsDimensionLimit(dimensions) {
  return dimensions.width > MAX_WIDTH
    || dimensions.height > MAX_HEIGHT
    || dimensions.width * dimensions.height > MAX_PIXELS;
}

async function ensureLocalTessdata() {
  await fs.mkdir(tessdataPath, { recursive: true });

  for (const language of OCR_LANGUAGES) {
    const sourcePath = ocrLanguagePackages[language];
    if (!sourcePath) {
      throw new Error(`OCR language is not installed: ${language}`);
    }

    const targetPath = path.join(tessdataPath, `${language}.traineddata.gz`);
    try {
      await fs.access(targetPath);
      continue;
    } catch {
      // tesseract.js expects every selected language under a single langPath.
    }

    try {
      await fs.symlink(sourcePath, targetPath);
    } catch {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function runOcrWithTimeout(filePath) {
  let worker;
  let timedOut = false;
  let timeoutId;
  const ocrTask = (async () => {
    await ensureLocalTessdata();
    worker = await createWorker(OCR_LANGUAGES, 1, {
      langPath: tessdataPath,
      cacheMethod: "none",
      errorHandler: (error) => {
        console.warn(`[image-ocr-extractor] worker_error="${error?.message || error}"`);
      }
    });
    const autoResult = await recognizeWithPsm(worker, filePath, PSM_AUTO, true);
    const tableLayoutDetected = isTableLikeLayout(autoResult.tsv);

    if (!tableLayoutDetected) {
      return { ...autoResult, tableLayoutDetected, tableRows: [] };
    }

    const singleColumnResult = await recognizeWithPsm(worker, filePath, PSM_SINGLE_COLUMN);
    const selectedResult = selectBestOcrResult(autoResult, singleColumnResult);
    return {
      ...selectedResult,
      tableLayoutDetected,
      tableRows: extractTableRowsFromTsv(autoResult.tsv, selectedResult.text)
    };
  })();

  try {
    return await Promise.race([
      ocrTask,
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`));
        }, OCR_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (worker) {
      await worker.terminate();
    }
    if (timedOut) {
      console.warn(`[image-ocr-extractor] timeout file="${filePath}"`);
    }
  }
}

async function recognizeWithPsm(worker, filePath, psm, includeTsv = false) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const result = await worker.recognize(filePath, {}, includeTsv ? { tsv: true } : undefined);
  return {
    text: result?.data?.text || "",
    confidence: result?.data?.confidence ?? 0,
    psm,
    tsv: includeTsv ? result?.data?.tsv || "" : ""
  };
}

const tableHeaderNames = new Set([
  "part", "partnumber", "material", "model", "modelno", "item", "itemno", "sku",
  "product", "productname", "description", "name", "qty", "quantity", "unit", "uom",
  "spec", "specification", "remarks", "remark", "code", "serial",
  "序号", "产品", "产品名称", "名称", "品名", "型号", "产品型号", "物料", "物料号",
  "料号", "货号", "数量", "单位", "规格", "备注"
]);

// Geometry alone mistakes wide web-page layouts for tables. Require a plausible
// header and at least one later row aligned to that header before producing rows.
export function isTableLikeLayout(tsv) {
  const layout = parseTsvLayout(tsv);
  const headerLine = findTableHeaderLine(layout);
  if (!headerLine) {
    return false;
  }
  const headerCells = groupLineWords(headerLine.words, layout.imageWidth);
  return layout.lines.some((line) => (
    line.top > headerLine.top
    && countAlignedCells(line.words, headerCells, layout.imageWidth) >= Math.min(2, headerCells.length)
  ));
}

// Converts OCR coordinates into the same header-to-row shape used by spreadsheet extraction.
export function extractTableRowsFromTsv(tsv, replacementText = "") {
  const layout = parseTsvLayout(tsv);
  const headerLine = findTableHeaderLine(layout);

  if (!headerLine) {
    return [];
  }

  const headerCells = groupLineWords(headerLine.words, layout.imageWidth);
  const headers = uniqueHeaders(resolveHeaderTexts(headerCells, replacementText));
  const columnStarts = headerCells.map((cell) => cell.left);
  const boundaries = columnStarts.slice(1).map((start, index) => (columnStarts[index] + start) / 2);

  return layout.lines
    .filter((line) => line.top > headerLine.top && line.words.length)
    .map((line) => {
      const row = Object.fromEntries(headers.map((header) => [header, ""]));
      groupLineWords(line.words, layout.imageWidth).forEach((cell) => {
        const columnIndex = boundaries.findIndex((boundary) => cell.left < boundary);
        const targetIndex = columnIndex === -1 ? headers.length - 1 : columnIndex;
        const header = headers[targetIndex];
        row[header] = [row[header], cell.text].filter(Boolean).join(" ");
      });
      return row;
    })
    .filter((row) => Object.values(row).some(Boolean));
}

function findTableHeaderLine(layout) {
  return layout.lines.find((line) => {
    if (!isWideGappedLine(line.words, layout.imageWidth)) {
      return false;
    }
    const cells = groupLineWords(line.words, layout.imageWidth);
    return cells.length >= 2 && cells.filter((cell) => isKnownTableHeader(cell.text)).length >= 2;
  });
}

function isKnownTableHeader(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[\s_：:./()-]+/g, "");
  return tableHeaderNames.has(normalized);
}

function countAlignedCells(words, headerCells, imageWidth) {
  const tolerance = imageWidth * 0.1;
  return groupLineWords(words, imageWidth).filter((cell) => (
    headerCells.some((header) => Math.abs(cell.left - header.left) <= tolerance)
  )).length;
}

function parseTsvLayout(tsv) {
  const wordsByLine = new Map();
  let imageWidth = 0;

  String(tsv || "").split("\n").slice(1).forEach((row) => {
    const columns = row.split("\t");
    if (columns.length < 12) {
      return;
    }

    const level = Number(columns[0]);
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    const text = String(columns.slice(11).join("\t") || "").trim();

    if (level === 1 && Number.isFinite(width)) {
      imageWidth = Math.max(imageWidth, width);
      return;
    }
    if (level !== 5 || !text || ![left, top, width, height].every(Number.isFinite)) {
      return;
    }

    const lineKey = columns.slice(1, 5).join(":");
    const line = wordsByLine.get(lineKey) || { top, words: [] };
    line.top = Math.min(line.top, top);
    line.words.push({ text, left, width });
    wordsByLine.set(lineKey, line);
    imageWidth = Math.max(imageWidth, left + width);
  });

  return {
    imageWidth,
    lines: [...wordsByLine.values()].map((line) => ({
      ...line,
      words: line.words.sort((left, right) => left.left - right.left)
    })).sort((left, right) => left.top - right.top)
  };
}

function isWideGappedLine(words, imageWidth) {
  if (!imageWidth || words.length < 2) {
    return false;
  }
  const lineStart = words[0].left;
  const lineEnd = Math.max(...words.map((word) => word.left + word.width));
  const largestGap = words.slice(1).reduce((largest, word, index) => {
    const previous = words[index];
    return Math.max(largest, word.left - (previous.left + previous.width));
  }, 0);
  return lineEnd - lineStart >= imageWidth * 0.5 && largestGap >= imageWidth * 0.15;
}

function groupLineWords(words, imageWidth) {
  const groupGap = Math.max(24, imageWidth * 0.04);
  return words.reduce((groups, word) => {
    const previous = groups.at(-1);
    if (!previous || word.left - previous.right > groupGap) {
      groups.push({ text: word.text, left: word.left, right: word.left + word.width, wordCount: 1 });
      return groups;
    }
    previous.text = `${previous.text} ${word.text}`;
    previous.right = Math.max(previous.right, word.left + word.width);
    previous.wordCount += 1;
    return groups;
  }, []);
}

function resolveHeaderTexts(headerCells, replacementText) {
  const replacementHeader = String(replacementText || "").split("\n").find((line) => line.trim()) || "";
  const words = replacementHeader.trim().split(/\s+/).filter(Boolean);
  const expectedWordCount = headerCells.reduce((total, cell) => total + cell.wordCount, 0);
  if (words.length !== expectedWordCount) {
    return headerCells.map((cell) => cell.text);
  }

  let cursor = 0;
  return headerCells.map((cell) => {
    const header = words.slice(cursor, cursor + cell.wordCount).join(" ");
    cursor += cell.wordCount;
    return header;
  });
}

function uniqueHeaders(cells) {
  const used = new Map();
  return cells.map((value, index) => {
    const base = String(value || "").trim() || `Column ${index + 1}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

export function selectBestOcrResult(autoResult, singleColumnResult) {
  const autoScore = scoreOcrResult(autoResult);
  const singleColumnScore = scoreOcrResult(singleColumnResult);
  return singleColumnScore > autoScore ? singleColumnResult : autoResult;
}

function scoreOcrResult(result) {
  const lines = String(result?.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z0-9\u4e00-\u9fff]/.test(line));
  const characterCount = lines.join("").replace(/\s/g, "").length;
  const confidence = Math.max(0, Math.min(100, Number(result?.confidence) || 0));

  // Favor complete, multi-line text first; confidence breaks otherwise-equal results.
  return lines.length * 100 + characterCount + confidence;
}

function normalizeOcrText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeConfidence(value) {
  const confidence = Number(value) || 0;
  if (confidence > 1) {
    return Number((confidence / 100).toFixed(2));
  }
  return Number(confidence.toFixed(2));
}

function baseMetadata(attachment) {
  return {
    filename: attachment.name || "attachment",
    mime_type: attachment.type || "",
    parser: "ocr",
    ocr_engine: "tesseract.js",
    language: OCR_LANGUAGE_LABEL,
    languages: OCR_LANGUAGES
  };
}

function createNoTextBlock(attachment, dimensions) {
  return {
    type: "image_ocr",
    source: attachment.name || "attachment",
    text: "",
    confidence: 0,
    metadata: {
      ...baseMetadata(attachment),
      status: "no_text_found",
      reason: "No readable text detected",
      width: dimensions.width,
      height: dimensions.height
    }
  };
}

function createSkippedBlock(attachment, reason, dimensions = null) {
  return {
    type: "image_ocr",
    source: attachment.name || "attachment",
    text: "",
    confidence: 0,
    metadata: {
      ...baseMetadata(attachment),
      status: "skipped",
      reason,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {})
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
      mime_type: attachment.type || "",
      parser: "ocr",
      status: "parse_failed",
      error: error?.message || "解析失败"
    }
  };
}
