import { UiHelpers } from "./domUtils.js";

async function runSequential(ids, runner) {
  const results = [];
  for (const id of ids) {
    try {
      await runner(id);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function summarizeResults(results, label) {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  if (failCount === 0) {
    return `${label}: ${okCount} succeeded.`;
  }
  return `${label}: ${okCount} succeeded, ${failCount} failed.`;
}

function updateBulkStatus(element, results, label) {
  const failCount = results.filter((r) => !r.ok).length;
  UiHelpers.showAlert(element, summarizeResults(results, label), failCount ? "warning" : "success");
}

export { runSequential, summarizeResults, updateBulkStatus };
