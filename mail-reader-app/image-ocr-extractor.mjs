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
        confidence,
        metadata: {
          filename,
          mime_type: mimeType,
          parser: "ocr",
          ocr_engine: "tesseract.js",
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
    const result = await worker.recognize(filePath);
    return {
      text: result?.data?.text || "",
      confidence: result?.data?.confidence ?? 0
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
