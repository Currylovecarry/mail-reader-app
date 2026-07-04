import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const attachmentRoot = path.join(__dirname, "imported-attachments");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 200;
const MAX_COLUMNS = 50;

const spreadsheetExtensions = new Set([".xlsx", ".xls", ".csv"]);
const spreadsheetMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/comma-separated-values"
]);

export function isSpreadsheetAttachment(attachment) {
  const extension = path.extname(attachment?.name || "").toLowerCase();
  const mimeType = String(attachment?.type || "").toLowerCase();
  return spreadsheetExtensions.has(extension) || spreadsheetMimeTypes.has(mimeType);
}

export async function extractSpreadsheetBlocks(attachment) {
  if (!isSpreadsheetAttachment(attachment)) {
    return [];
  }

  const filename = attachment.name || "attachment";
  const parser = getParserName(filename, attachment.type);
  console.info(`[spreadsheet-extractor] detected filename="${filename}" parser=${parser}`);

  try {
    const filePath = resolveAttachmentPath(attachment);
    if (!filePath) {
      throw new Error("附件没有可读取的本地存储路径");
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`附件超过 ${MAX_FILE_SIZE} 字节限制`);
    }

    const blocks = parser === "csv"
      ? [await extractCsvBlock(filePath, filename)]
      : await extractWorkbookBlocks(filePath, filename);

    const parsedRows = blocks.reduce((sum, block) => sum + (block.metadata.row_count || 0), 0);
    console.info(`[spreadsheet-extractor] parsed filename="${filename}" blocks=${blocks.length} rows=${parsedRows}`);
    return blocks;
  } catch (error) {
    console.warn(`[spreadsheet-extractor] failed filename="${filename}" error="${error.message || error}"`);
    return [createErrorBlock(attachment, parser, error)];
  }
}

function getParserName(filename, mimeType = "") {
  const extension = path.extname(filename || "").toLowerCase();
  if (extension === ".csv" || String(mimeType).toLowerCase() === "text/csv") {
    return "csv";
  }
  return "excel";
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

async function extractWorkbookBlocks(filePath, filename) {
  const workbook = xlsx.readFile(filePath, {
    cellDates: false,
    cellNF: false,
    cellStyles: false,
    sheetRows: MAX_ROWS + 2
  });

  const blocks = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = normalizeMatrix(xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false }));
    if (!matrix.length) {
      continue;
    }
    blocks.push(matrixToBlock(matrix, {
      filename,
      source: `${filename}#${sheetName}`,
      sheetName,
      parser: "excel"
    }));
  }

  return blocks;
}

async function extractCsvBlock(filePath, filename) {
  const content = await fs.readFile(filePath, "utf8");
  const matrix = normalizeMatrix(parseCsv(content.replace(/^\uFEFF/, "")));
  if (!matrix.length) {
    return createEmptySpreadsheetBlock(filename, "csv");
  }
  return matrixToBlock(matrix, {
    filename,
    source: filename,
    sheetName: "",
    parser: "csv"
  });
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeMatrix(matrix) {
  return (Array.isArray(matrix) ? matrix : [])
    .map((row) => (Array.isArray(row) ? row : []).map((cell) => normalizeCell(cell)))
    .filter((row) => row.some(Boolean));
}

function normalizeCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function matrixToBlock(matrix, options) {
  const originalColumnCount = Math.max(...matrix.map((row) => row.length));
  const truncatedColumns = originalColumnCount > MAX_COLUMNS;
  const limitedMatrix = matrix.slice(0, MAX_ROWS + 1).map((row) => row.slice(0, MAX_COLUMNS));
  const truncatedRows = matrix.length > MAX_ROWS + 1;
  const firstRow = limitedMatrix[0] || [];
  const headerDetected = isLikelyHeader(firstRow);
  const headers = headerDetected
    ? normalizeHeaders(firstRow)
    : Array.from({ length: Math.max(firstRow.length, 1) }, (_value, index) => `Column ${index + 1}`);
  const dataRows = headerDetected ? limitedMatrix.slice(1) : limitedMatrix;
  const rows = dataRows.map((row) => rowToObject(row, headers));
  const text = rowsToMarkdown(headers, rows);
  const truncated = truncatedRows || truncatedColumns;

  if (truncated) {
    console.info(
      `[spreadsheet-extractor] truncated filename="${options.filename}" sheet="${options.sheetName || ""}" rows=${matrix.length} columns=${originalColumnCount}`
    );
  }

  return {
    type: "spreadsheet",
    source: options.source,
    text,
    rows,
    confidence: 0.95,
    metadata: {
      filename: options.filename,
      ...(options.sheetName ? { sheet_name: options.sheetName } : {}),
      row_count: rows.length,
      column_count: headers.length,
      parser: options.parser,
      status: "parsed",
      ...(truncated ? { truncated: true } : {}),
      header_detected: headerDetected
    }
  };
}

function isLikelyHeader(row) {
  const cells = row.filter(Boolean);
  if (!cells.length) {
    return false;
  }
  const textCells = cells.filter((cell) => /[A-Za-z\u4e00-\u9fa5]/.test(cell));
  return textCells.length > 0 && textCells.length >= Math.ceil(cells.length / 2);
}

function normalizeHeaders(row) {
  const seen = new Map();
  return row.map((header, index) => {
    const base = header || `Column ${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
}

function rowToObject(row, headers) {
  const item = {};
  headers.forEach((header, index) => {
    item[header] = row[index] || "";
  });
  return item;
}

function rowsToMarkdown(headers, rows) {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeMarkdownCell(row[header])).join(" | ")} |`)
  ].join("\n");
}

function escapeMarkdownCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function createEmptySpreadsheetBlock(filename, parser) {
  return {
    type: "spreadsheet",
    source: filename,
    text: "",
    rows: [],
    confidence: 0.95,
    metadata: {
      filename,
      row_count: 0,
      column_count: 0,
      parser,
      status: "parsed"
    }
  };
}

function createErrorBlock(attachment, parser, error) {
  return {
    type: "attachment_error",
    source: attachment.name || "attachment",
    text: "",
    confidence: 0,
    metadata: {
      filename: attachment.name || "attachment",
      parser,
      status: "parse_failed",
      error: error?.message || "解析失败"
    }
  };
}
