// Smoke assertions for the polish API routes against a running server build.
//
//   node scripts/smoke-polish-api.mjs [baseUrl]     (default http://localhost:3000)
//
// Phase 0 stub contract (src/server/polish/handler.ts, unit 0.1): both polish
// routes answer every request with
//
//   503  { requestId, error: { code: "AI_DISABLED", message } }
//
// plus `Cache-Control: no-store` and `X-Request-Id` echoing body.requestId.
//
// TODO(unit 2.3): once the real request lifecycle (auth → terms → bounded
// reader → …) lands, token-less requests are rejected by auth BEFORE the stub
// path — update this script to assert 401 UNAUTHORIZED (same error envelope)
// instead of 503 AI_DISABLED. ci.yml's web-server-build job calls this script.

const baseUrl = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectAiDisabled(label, response) {
  check(`${label}: status 503`, response.status === 503, `got ${response.status}`);
  check(
    `${label}: Cache-Control no-store`,
    (response.headers.get("cache-control") ?? "").includes("no-store"),
    `got ${response.headers.get("cache-control")}`,
  );

  let body;
  try {
    body = await response.json();
  } catch (error) {
    check(`${label}: JSON body`, false, String(error));
    return;
  }

  check(
    `${label}: requestId is a non-empty string`,
    typeof body?.requestId === "string" && body.requestId.length > 0,
  );
  check(
    `${label}: error.code is AI_DISABLED`,
    body?.error?.code === "AI_DISABLED",
    `got ${body?.error?.code}`,
  );
  check(
    `${label}: error.message is a non-empty string`,
    typeof body?.error?.message === "string" && body.error.message.length > 0,
  );
  check(
    `${label}: X-Request-Id echoes requestId`,
    response.headers.get("x-request-id") === body?.requestId,
    `got ${response.headers.get("x-request-id")}`,
  );
}

const polish = await fetch(`${baseUrl}/api/polish`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await expectAiDisabled("POST /api/polish", polish);

const quota = await fetch(`${baseUrl}/api/polish/quota`);
await expectAiDisabled("GET /api/polish/quota", quota);

if (failures > 0) {
  console.error(`\n${failures} smoke assertion(s) failed against ${baseUrl}`);
  process.exit(1);
}
console.log(`\nAll smoke assertions passed against ${baseUrl}`);
