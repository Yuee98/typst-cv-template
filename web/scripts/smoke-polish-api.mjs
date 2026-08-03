// Smoke assertions for the polish API routes against a running server build.
//
//   node scripts/smoke-polish-api.mjs [baseUrl]     (default http://localhost:3000)
//
// Post-2.3 the routes serve the real request lifecycle (src/server/polish/
// handler.ts + lifecycle.ts). The script asserts, in order:
//
//   1. POST /api/polish WITHOUT a token → 401 UNAUTHORIZED (works in every
//      mode; the deployment switch is on for the smoke server).
//   2. GET /api/polish/quota WITHOUT a token → 401 UNAUTHORIZED.
//   3. Full chain with a token → 200 success shape. This requires the CI
//      fake backend (POLISH_FAKE_LLM=true + POLISH_FAKE_BACKEND=true), where
//      any Bearer token authenticates and the deterministic fake LLM echoes
//      the targets, so the whole lifecycle (auth → reserve → orchestrate →
//      finalize) runs without Supabase or a DeepSeek key.
//   4. GET /api/polish/quota with a token → 200 quota shape.
//
// Every response must carry `Cache-Control: no-store` and an `X-Request-Id`
// header echoing body.requestId. ci.yml's web-server-build job runs this
// against `next start` with the fake flags set.

const baseUrl = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");

// Any token authenticates against the fake backend; the value only needs to
// be well-formed.
const SMOKE_TOKEN = "ci-smoke-token";

const POLISH_BODY = {
  clientRequestId: crypto.randomUUID(),
  granularity: "item",
  sectionId: "experience",
  language: "zh",
  items: [
    {
      id: "i0",
      kind: "experience_bullet",
      text: "负责后端核心服务的开发与优化，将 P99 延迟降低 40%。",
    },
  ],
  context: { level: 0, references: [] },
};

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function readJson(label, response) {
  try {
    return await response.json();
  } catch (error) {
    check(`${label}: JSON body`, false, String(error));
    return null;
  }
}

function checkCommonHeaders(label, response, body) {
  check(
    `${label}: Cache-Control no-store`,
    (response.headers.get("cache-control") ?? "").includes("no-store"),
    `got ${response.headers.get("cache-control")}`,
  );
  check(
    `${label}: X-Request-Id echoes body requestId`,
    body !== null && response.headers.get("x-request-id") === body.requestId,
    `got ${response.headers.get("x-request-id")} vs body ${body?.requestId}`,
  );
}

async function expectUnauthorized(label, response) {
  check(`${label}: status 401`, response.status === 401, `got ${response.status}`);
  const body = await readJson(label, response);
  if (body === null) return;
  check(
    `${label}: requestId is a non-empty string`,
    typeof body?.requestId === "string" && body.requestId.length > 0,
  );
  check(
    `${label}: error.code is UNAUTHORIZED`,
    body?.error?.code === "UNAUTHORIZED",
    `got ${body?.error?.code}`,
  );
  check(
    `${label}: error.message is a non-empty string`,
    typeof body?.error?.message === "string" && body.error.message.length > 0,
  );
  checkCommonHeaders(label, response, body);
}

// 1./2. Token-less requests are rejected by auth with 401 UNAUTHORIZED.
const polishNoToken = await fetch(`${baseUrl}/api/polish`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await expectUnauthorized("POST /api/polish (no token)", polishNoToken);

const quotaNoToken = await fetch(`${baseUrl}/api/polish/quota`);
await expectUnauthorized("GET /api/polish/quota (no token)", quotaNoToken);

// 3. Full chain through the fake backend: one item-granularity request.
const polish = await fetch(`${baseUrl}/api/polish`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${SMOKE_TOKEN}`,
  },
  body: JSON.stringify(POLISH_BODY),
});
check("POST /api/polish: status 200", polish.status === 200, `got ${polish.status}`);
const polishBody = await readJson("POST /api/polish", polish);
if (polishBody !== null) {
  check(
    "POST /api/polish: requestId is a non-empty string",
    typeof polishBody?.requestId === "string" && polishBody.requestId.length > 0,
  );
  check(
    "POST /api/polish: echoes the target item 1:1",
    Array.isArray(polishBody?.items) &&
      polishBody.items.length === 1 &&
      polishBody.items[0]?.id === "i0" &&
      polishBody.items[0]?.polished === POLISH_BODY.items[0].text,
    `got ${JSON.stringify(polishBody?.items)}`,
  );
  check(
    "POST /api/polish: quota {limit, remaining, resetAt} present",
    Number.isInteger(polishBody?.quota?.limit) &&
      Number.isInteger(polishBody?.quota?.remaining) &&
      typeof polishBody?.quota?.resetAt === "string",
    `got ${JSON.stringify(polishBody?.quota)}`,
  );
  checkCommonHeaders("POST /api/polish", polish, polishBody);
}

// 4. Quota route with a token.
const quota = await fetch(`${baseUrl}/api/polish/quota`, {
  headers: { authorization: `Bearer ${SMOKE_TOKEN}` },
});
check("GET /api/polish/quota: status 200", quota.status === 200, `got ${quota.status}`);
const quotaBody = await readJson("GET /api/polish/quota", quota);
if (quotaBody !== null) {
  check(
    "GET /api/polish/quota: quota {limit, remaining, resetAt} present",
    Number.isInteger(quotaBody?.quota?.limit) &&
      Number.isInteger(quotaBody?.quota?.remaining) &&
      typeof quotaBody?.quota?.resetAt === "string",
    `got ${JSON.stringify(quotaBody?.quota)}`,
  );
  checkCommonHeaders("GET /api/polish/quota", quota, quotaBody);
}

if (failures > 0) {
  console.error(`\n${failures} smoke assertion(s) failed against ${baseUrl}`);
  process.exit(1);
}
console.log(`\nAll smoke assertions passed against ${baseUrl}`);
