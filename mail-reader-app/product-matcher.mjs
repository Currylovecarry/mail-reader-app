const knownMaterials = new Set(["NI", "B", "ST", "A2", "A4", "CU", "AL", "MS", "SS"]);

export const PRODUCT_MATCH_CONFIG = Object.freeze({
  topK: 3,
  candidateScoreCutoff: 40,
  minimumMatchFinalScore: 60,
  fuzzyWeight: 0.7,
  specWeight: 0.3
});

export function matchProduct(item, catalog, config = {}) {
  const options = { ...PRODUCT_MATCH_CONFIG, ...config };
  const normalizedCode = String(item?.model_normalized || "").trim();
  const activeCatalog = (Array.isArray(catalog) ? catalog : [])
    .filter((product) => product?.active !== 0 && product?.normalized_code);

  if (!normalizedCode) {
    return noMatchResult("empty_model", [], "none");
  }

  const exactMatches = activeCatalog.filter(
    (product) => product.normalized_code === normalizedCode
  );
  if (exactMatches.length === 1) {
    const product = exactMatches[0];
    return {
      match_status: "exact_match",
      match_method: "exact",
      final_score: 100,
      spec_warning: "",
      need_manual_review: false,
      review_reason: "",
      selected_product_id: product.id,
      review_status: "auto_confirmed",
      candidates: [{
        product_id: product.id,
        product_code: product.product_code,
        normalized_code: product.normalized_code,
        rank: 1,
        fuzzy_score: 100,
        spec_score: 100,
        final_score: 100,
        match_reason: "标准化型号完全一致"
      }]
    };
  }

  if (exactMatches.length > 1) {
    const candidates = exactMatches.slice(0, options.topK).map((product, index) => ({
      product_id: product.id,
      product_code: product.product_code,
      normalized_code: product.normalized_code,
      rank: index + 1,
      fuzzy_score: 100,
      spec_score: 100,
      final_score: 100,
      match_reason: "多个产品具有相同标准化型号"
    }));
    return {
      match_status: "exact_match",
      match_method: "exact_duplicate",
      final_score: 100,
      spec_warning: "",
      need_manual_review: true,
      review_reason: "duplicate_exact_match",
      selected_product_id: null,
      review_status: "pending",
      candidates
    };
  }

  const querySpec = parseSpecFromCode(normalizedCode);
  const candidates = activeCatalog
    .map((product) => {
      const fuzzyScore = partialRatio(normalizedCode, product.normalized_code);
      const specResult = compareSpec(querySpec, parseSpecFromCode(product.normalized_code));
      const finalScore = Math.floor(
        options.fuzzyWeight * fuzzyScore + options.specWeight * specResult.spec_score
      );
      return {
        product_id: product.id,
        product_code: product.product_code,
        normalized_code: product.normalized_code,
        fuzzy_score: fuzzyScore,
        spec_score: specResult.spec_score,
        final_score: finalScore,
        spec_warning: specResult.spec_warning,
        match_reason: buildMatchReason(fuzzyScore, specResult)
      };
    })
    .filter((candidate) => candidate.fuzzy_score >= options.candidateScoreCutoff)
    .sort(compareCandidates)
    .slice(0, options.topK)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  if (!candidates.length) {
    return noMatchResult("no_candidate_above_cutoff", [], "fuzzy");
  }

  const top = candidates[0];
  if (top.final_score < options.minimumMatchFinalScore) {
    return noMatchResult(
      "fuzzy_score_below_match_threshold",
      candidates,
      "fuzzy_below_threshold",
      top
    );
  }

  return {
    match_status: "fuzzy_match",
    match_method: "partial_ratio_with_spec",
    final_score: top.final_score,
    spec_warning: top.spec_warning,
    need_manual_review: true,
    review_reason: top.spec_warning || "fuzzy_match_requires_review",
    selected_product_id: null,
    review_status: "pending",
    candidates
  };
}

export function parseSpecFromCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const empty = {
    series: "",
    size: "",
    thread: "",
    material: "",
    variant: "",
    parser_type: "generic",
    spec_confidence: 10,
    parse_warning: "empty_code"
  };
  if (!normalized) {
    return empty;
  }

  if (/^GN\d/.test(normalized)) {
    return {
      ...parseGnCode(normalized),
      parser_type: "gn",
      spec_confidence: 90
    };
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return {
      series: normalized,
      size: "",
      thread: "",
      material: "",
      variant: "",
      parser_type: "numeric",
      spec_confidence: 20,
      parse_warning: "unparsed_numeric_code"
    };
  }
  return {
    ...parseGenericCode(normalized),
    parser_type: "generic",
    spec_confidence: 40
  };
}

export function compareSpec(querySpec, candidateSpec) {
  const queryConfidence = Number(querySpec?.spec_confidence ?? 50);
  const candidateConfidence = Number(candidateSpec?.spec_confidence ?? 50);
  if (queryConfidence < 50 || candidateConfidence < 50) {
    return { spec_score: 70, spec_warning: "" };
  }

  let score = 100;
  const warnings = [];
  if (querySpec.thread && candidateSpec.thread && querySpec.thread !== candidateSpec.thread) {
    score -= 40;
    warnings.push("thread_conflict");
  }
  if (querySpec.size && candidateSpec.size && querySpec.size !== candidateSpec.size) {
    score -= 30;
    warnings.push("size_conflict");
  }
  if (querySpec.material && candidateSpec.material && querySpec.material !== candidateSpec.material) {
    score -= 10;
    warnings.push("material_mismatch");
  }
  if (queryConfidence >= 70 && candidateConfidence >= 70) {
    if (
      (querySpec.thread && !candidateSpec.thread)
      || (querySpec.size && !candidateSpec.size)
    ) {
      score -= 10;
      if (!warnings.length) {
        warnings.push("missing_spec");
      }
    }
  }

  return {
    spec_score: Math.max(0, score),
    spec_warning: warnings.join(",")
  };
}

export function partialRatio(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 100;
  }

  const [shorter, longer] = left.length <= right.length
    ? [left, right]
    : [right, left];
  let best = similarityRatio(shorter, longer);
  const minimumWindow = Math.max(1, shorter.length - 2);
  const maximumWindow = Math.min(longer.length, shorter.length + 2);

  for (let windowLength = minimumWindow; windowLength <= maximumWindow; windowLength += 1) {
    for (let start = 0; start + windowLength <= longer.length; start += 1) {
      best = Math.max(
        best,
        similarityRatio(shorter, longer.slice(start, start + windowLength))
      );
    }
  }

  return Number(best.toFixed(1));
}

function parseGnCode(code) {
  const parts = code.split("-");
  const result = {
    series: parts[0],
    size: "",
    thread: "",
    material: "",
    variant: "",
    parse_warning: ""
  };
  for (const part of parts.slice(1)) {
    if (!part) {
      continue;
    }
    if (/^M\d+$/i.test(part)) {
      result.thread = part.toUpperCase();
    } else if (/^\d+$/.test(part)) {
      result.size = part;
    } else if (knownMaterials.has(part.toUpperCase())) {
      result.material = part.toUpperCase();
    } else if (/^[A-Z]+$/i.test(part)) {
      result.variant = part.toUpperCase();
    } else {
      result.variant = result.variant
        ? `${result.variant}-${part.toUpperCase()}`
        : part.toUpperCase();
    }
  }
  return result;
}

function parseGenericCode(code) {
  const parts = code.split("-");
  const result = {
    series: parts[0] || code,
    size: "",
    thread: "",
    material: "",
    variant: "",
    parse_warning: "unparsed_generic_code"
  };
  for (const part of parts.slice(1).reverse()) {
    if (/^M\d+$/i.test(part) && !result.thread) {
      result.thread = part.toUpperCase();
    } else if (/^\d+$/.test(part) && !result.size) {
      result.size = part;
    } else if (knownMaterials.has(part.toUpperCase()) && !result.material) {
      result.material = part.toUpperCase();
    }
  }
  return result;
}

function similarityRatio(left, right) {
  const maximumLength = Math.max(left.length, right.length);
  if (!maximumLength) {
    return 100;
  }
  return (1 - levenshteinDistance(left, right) / maximumLength) * 100;
}

function levenshteinDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function compareCandidates(left, right) {
  return right.fuzzy_score - left.fuzzy_score
    || right.final_score - left.final_score
    || left.normalized_code.localeCompare(right.normalized_code);
}

function buildMatchReason(fuzzyScore, specResult) {
  const parts = [`partial_ratio=${fuzzyScore}`];
  parts.push(`spec_score=${specResult.spec_score}`);
  if (specResult.spec_warning) {
    parts.push(specResult.spec_warning);
  }
  return parts.join(";");
}

function noMatchResult(reason, candidates, method, topCandidate = null) {
  return {
    match_status: "no_match",
    match_method: method,
    final_score: topCandidate?.final_score || 0,
    spec_warning: topCandidate?.spec_warning || "",
    need_manual_review: true,
    review_reason: reason,
    selected_product_id: null,
    review_status: "pending",
    candidates
  };
}
