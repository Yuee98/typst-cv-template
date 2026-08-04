/** Pure/testable helpers used by the manual AI metrics command. */

export const DEFAULT_PAGE_SIZE = 1000;

export async function collectAllPages(loadPage, pageSize = DEFAULT_PAGE_SIZE) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await loadPage(offset, offset + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}

function totals(rows) {
  return {
    inputCached: sum(rows, "input_cached_tokens"),
    inputUncached: sum(rows, "input_uncached_tokens"),
    output: sum(rows, "output_tokens"),
  };
}

function hasKnownUsage(row) {
  return (
    row.input_cached_tokens !== null ||
    row.input_uncached_tokens !== null ||
    row.output_tokens !== null
  );
}

function hasInputUsage(row) {
  return (row.input_cached_tokens ?? 0) + (row.input_uncached_tokens ?? 0) > 0;
}

export function summarizeTokenUsage(finalizedRows) {
  const known = finalizedRows.filter(hasKnownUsage);
  const complete = finalizedRows.filter((row) => row.usage_complete === true);
  const incompleteKnown = finalizedRows.filter(
    (row) => row.usage_complete !== true && hasKnownUsage(row),
  );
  const completeWithInput = complete.filter(hasInputUsage);
  const succeededCompleteWithInput = completeWithInput.filter(
    (row) => row.status === "succeeded",
  );

  return {
    known: { count: known.length, totals: totals(known) },
    complete: { count: complete.length, totals: totals(complete) },
    incompleteKnown: {
      count: incompleteKnown.length,
      totals: totals(incompleteKnown),
    },
    completeWithInput: {
      count: completeWithInput.length,
      totals: totals(completeWithInput),
    },
    succeededCompleteWithInput: {
      count: succeededCompleteWithInput.length,
      totals: totals(succeededCompleteWithInput),
    },
  };
}

export function classifyGlobalUsage(used, limit, alertThreshold = 0.8) {
  if (limit === 0 && used === 0) return { level: "disabled", ratio: null };
  const ratio = limit > 0 ? used / limit : Number.POSITIVE_INFINITY;
  if (ratio >= 1) return { level: "critical", ratio };
  if (ratio >= alertThreshold) return { level: "alert", ratio };
  return { level: "ok", ratio };
}
