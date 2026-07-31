const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\""
};

export function decodeHtmlEntities(value, { maxPasses = 2 } = {}) {
  let decoded = String(value ?? "").replace(/\u00a0/g, " ");
  const passes = Math.max(1, Number(maxPasses) || 1);

  for (let pass = 0; pass < passes; pass += 1) {
    const next = decoded.replace(
      /&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/gi,
      (entity, decimalCode, hexadecimalCode, namedEntity) => {
        if (decimalCode) {
          return decodeCodePoint(Number(decimalCode), entity);
        }
        if (hexadecimalCode) {
          return decodeCodePoint(Number.parseInt(hexadecimalCode, 16), entity);
        }
        return NAMED_ENTITIES[namedEntity.toLowerCase()] ?? entity;
      }
    );
    decoded = next.replace(/\u00a0/g, " ");
    if (next === decoded && !/&(?:#\d+|#x[a-f0-9]+|[a-z]+);/i.test(decoded)) {
      break;
    }
  }

  return decoded;
}

function decodeCodePoint(codePoint, fallback) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
