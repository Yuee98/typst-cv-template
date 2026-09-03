// Request-time smoke for the real server composition with AI_POLISH_ENABLED
// disabled. Every route must stop before authentication or backend access.
//
//   node scripts/smoke-polish-disabled.mjs [baseUrl]

const baseUrl = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");

const routes = [
  {
    label: "POST /api/polish",
    url: `${baseUrl}/api/polish`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  },
  {
    label: "GET /api/polish/quota",
    url: `${baseUrl}/api/polish/quota`,
  },
  {
    label: "GET /api/polish/availability",
    url: `${baseUrl}/api/polish/availability`,
  },
];

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

for (const route of routes) {
  let response;
  try {
    response = await fetch(route.url, {
      ...route.init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    check(`${route.label}: bounded request`, false, String(error));
    continue;
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    check(`${route.label}: JSON body`, false, String(error));
  }

  check(`${route.label}: status 503`, response.status === 503, `got ${response.status}`);
  check(
    `${route.label}: AI_DISABLED`,
    body?.error?.code === "AI_DISABLED",
    `got ${body?.error?.code}`,
  );
  check(
    `${route.label}: request id`,
    typeof body?.requestId === "string" &&
      body.requestId.length > 0 &&
      response.headers.get("x-request-id") === body.requestId,
  );
  check(
    `${route.label}: no-store`,
    (response.headers.get("cache-control") ?? "").includes("no-store"),
  );
  check(`${route.label}: Retry-After`, response.headers.get("retry-after") === "300");
}

if (failures > 0) {
  console.error(`\n${failures} disabled-gate smoke assertion(s) failed against ${baseUrl}`);
  process.exit(1);
}

console.log(`\nAll disabled-gate smoke assertions passed against ${baseUrl}`);
