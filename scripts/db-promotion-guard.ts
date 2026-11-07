import { input, migrationManifest, run } from "./db-common.ts";
import { checkPromotion } from "./db-safety.ts";
function liveState() {
  if (process.env.GITHUB_ACTIONS !== "true") return process.env.DB_REBUILD_STATE_PROD;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[-\w.]+\/[-\w.]+$/.test(repo) || !process.env.GH_TOKEN) throw new Error("Promotion requires authenticated live durable-state lookup");
  // Workflow dispatch vars are a snapshot and cannot prove that maintenance has not started since dispatch.
  const page = JSON.parse(run("gh", ["api", `repos/${repo}/actions/variables?per_page=100`]));
  if (!Array.isArray(page.variables) || page.total_count > 100) throw new Error("Cannot prove complete repository variable lookup");
  return page.variables.find((entry: {
    name: string;
  }) => entry.name === "DB_REBUILD_STATE_PROD")?.value;
}
checkPromotion({
  ...process.env,
  DB_REBUILD_STATE_PROD: liveState()
}, input("source-sha"), migrationManifest());
console.log("Promotion database maintenance guard passed.");
