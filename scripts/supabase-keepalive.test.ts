import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/supabase-keepalive.yml", import.meta.url), "utf8");
const activityStep = workflow.split("      - name: Generate database activity\n")[1];
assert(activityStep, "Keepalive activity step is required");
const activity = activityStep.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");
assert(activity, "Keepalive shell block is required");

function runActivity(status: number, body: string, transportExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), "cv-keepalive-"));
  try {
    // Execute the actual workflow shell block. Only curl is replaced; no network
    // or real project credentials are involved in these health-check cases.
    const mockCurl = `
curl() {
  printf 'call\\n' >> "$RUNNER_TEMP/calls"
  local output_file=''
  local endpoint=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) output_file="$2"; shift 2 ;;
      https://*) endpoint="$1"; shift ;;
      *) shift ;;
    esac
  done
  [ "$endpoint" = "$SUPABASE_URL/rest/v1/rpc/keep_project_active" ] || return 90
  [ -n "$output_file" ] || return 91
  printf '%s' "$TEST_RESPONSE_BODY" > "$output_file"
  printf '%s' "$TEST_HTTP_STATUS"
  return "$TEST_TRANSPORT_EXIT"
}
`;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${mockCurl}\n${activity}`], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: directory,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        SUPABASE_URL: "https://fixture.invalid",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
        TARGET: "preview",
        TEST_HTTP_STATUS: String(status),
        TEST_RESPONSE_BODY: body,
        TEST_TRANSPORT_EXIT: String(transportExit)
      }
    });
    assert.equal(result.error, undefined);
    return {
      ...result,
      calls: readFileSync(join(directory, "calls"), "utf8").trim().split("\n").length
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("keepalive accepts HTTP success independently of RPC return payload", () => {
  for (const [status, body] of [[200, "true"], [200, '"2026-11-09T00:00:00Z"'], [200, '{"ok":true}'], [200, "null"], [204, ""]] as const) {
    const result = runActivity(status, body);
    assert.equal(result.status, 0, `HTTP ${status}, body ${body}: ${result.stdout}${result.stderr}`);
    assert.equal(result.calls, 3);
    assert.match(result.stdout, /database request 3\/3 succeeded/);
  }
});

test("keepalive rejects redirects and failed HTTP responses without treating body as health", () => {
  for (const status of [302, 401, 500]) {
    const result = runActivity(status, "true");
    assert.notEqual(result.status, 0, `HTTP ${status}`);
    assert.equal(result.calls, 1);
    assert.doesNotMatch(result.stdout, /succeeded/);
  }
});

test("keepalive fails on transport errors even when curl reports an apparent success status", () => {
  const result = runActivity(200, "true", 7);
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, 1);
  assert.doesNotMatch(result.stdout, /succeeded/);
});
