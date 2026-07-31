import { extractSpreadsheetBlocks, isSpreadsheetAttachment } from "./spreadsheet-extractor.mjs";
import { extractPdfBlocks, isPdfAttachment } from "./pdf-extractor.mjs";
import { extractImageOcrBlocks, isImageAttachment } from "./image-ocr-extractor.mjs";
import { decodeHtmlEntities } from "./html-entities.mjs";

function normalizeText(value) {
  return decodeHtmlEntities(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function stripHtmlToText(html) {
  return normalizeText(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<\/t[dh]>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function extractTagContent(html, tagName) {
  const pattern = new RegExp(`<(?:${tagName})\\b[^>]*>([\\s\\S]*?)<\\/(?:${tagName})>`, "gi");
  const matches = [];
  let match;
  while ((match = pattern.exec(html))) {
    matches.push(match[1]);
  }
  return matches;
}

function parseHtmlTable(tableHtml) {
  const rowHtmlList = extractTagContent(tableHtml, "tr");
  const matrix = rowHtmlList
    .map((rowHtml) => extractTagContent(rowHtml, "th|td").map(stripHtmlToText))
    .filter((row) => row.some(Boolean));

  if (!matrix.length) {
    return null;
  }

  const firstRow = matrix[0];
  const hasExplicitHeader = /<th\b/i.test(rowHtmlList[0] || "");
  const headers = (hasExplicitHeader ? firstRow : firstRow.map((_cell, index) => `Column ${index + 1}`))
    .map((header, index) => header || `Column ${index + 1}`);
  const dataRows = hasExplicitHeader ? matrix.slice(1) : matrix;
  const columnCount = Math.max(headers.length, ...dataRows.map((row) => row.length));
  const normalizedHeaders = Array.from({ length: columnCount }, (_value, index) => headers[index] || `Column ${index + 1}`);

  const rows = dataRows.map((row) => {
    const item = {};
    normalizedHeaders.forEach((header, index) => {
      item[header] = row[index] || "";
    });
    return item;
  });

  const markdownRows = [
    `| ${normalizedHeaders.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${normalizedHeaders.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${normalizedHeaders.map((header) => escapeMarkdownCell(row[header])).join(" | ")} |`)
  ];

  return {
    text: markdownRows.join("\n"),
    rows,
    rowCount: rows.length,
    columnCount
  };
}

function escapeMarkdownCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function extractTables(html) {
  return extractTagContent(html, "table")
    .map(parseHtmlTable)
    .filter(Boolean)
    .filter((table) => table.rowCount > 0 && table.columnCount > 0);
}

function parseAttachmentSize(attachment) {
  if (Number.isFinite(Number(attachment.size))) {
    return Number(attachment.size);
  }

  const summary = Array.isArray(attachment.summary) ? attachment.summary.join("\n") : "";
  const sizeMatch = summary.match(/大小\s*:\s*(\d+)/);
  return sizeMatch ? Number(sizeMatch[1]) : 0;
}

function isRealAttachment(attachment) {
  return attachment?.name && attachment.name !== "无附件";
}

function attachmentPathOrId(attachment) {
  return attachment.filePath || attachment.previewPath || attachment.downloadUrl || attachment.id || "";
}

export async function extractEmailContent(mail) {
  if (!mail) {
    throw new Error("邮件不存在");
  }

  const htmlBody = mail.htmlBody || "";
  const plainText = normalizeText(mail.textBody || (Array.isArray(mail.body) ? mail.body.join("\n") : ""));
  const bodyText = plainText || stripHtmlToText(htmlBody);
  const contentBlocks = [];

  if (bodyText) {
    contentBlocks.push({
      type: "body_text",
      source: "email_body",
      text: bodyText,
      confidence: 1.0,
      metadata: {}
    });
  }

  extractTables(htmlBody).forEach((table, index) => {
    contentBlocks.push({
      type: "table",
      source: "email_html_table",
      text: table.text,
      rows: table.rows,
      confidence: 1.0,
      metadata: {
        table_index: index,
        row_count: table.rowCount,
        column_count: table.columnCount
      }
    });
  });

  for (const attachment of (mail.attachments || []).filter(isRealAttachment)) {
    contentBlocks.push({
      type: "attachment",
      source: attachment.name,
      text: "",
      confidence: 0,
      metadata: {
        filename: attachment.name,
        mime_type: attachment.type || "",
        size: parseAttachmentSize(attachment),
        storage_path: attachmentPathOrId(attachment),
        status: "not_parsed_yet"
      }
    });

    if (isSpreadsheetAttachment(attachment)) {
      const spreadsheetBlocks = await extractSpreadsheetBlocks(attachment);
      contentBlocks.push(...spreadsheetBlocks);
    }

    if (isPdfAttachment(attachment)) {
      const pdfBlocks = await extractPdfBlocks(attachment);
      contentBlocks.push(...pdfBlocks);
    }

    if (isImageAttachment(attachment)) {
      const imageOcrBlocks = await extractImageOcrBlocks(attachment);
      contentBlocks.push(...imageOcrBlocks);
    }
  }

  return {
    email_id: mail.id,
    subject: mail.subject || "",
    from: mail.sender || mail.listEmail || "",
    received_at: mail.time || "",
    content_blocks: contentBlocks
  };
}
