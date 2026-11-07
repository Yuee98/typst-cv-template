// Test-server preload only; never imported by application code or the build.
// Keep the paired fake backend in its A/B period so MiMo is the nondefault provider.
if (process.env.CI !== "true" || process.env.POLISH_FAKE_BACKEND !== "true" || process.env.POLISH_FAKE_LLM !== "true") {
  throw new Error("Provider-choice test clock requires the isolated paired fake server");
}
const ActualDate = globalThis.Date;
const instant = ActualDate.parse("2026-11-07T01:00:00.000Z");
// Preserve native own descriptors (parse/UTC/prototype), which Next copies when
// installing its Date instrumentation. Timers and performance remain real.
globalThis.Date = new Proxy(ActualDate, {
  apply: () => new ActualDate(instant).toString(),
  construct: (target, values, newTarget) => Reflect.construct(target, values.length ? values : [instant], newTarget),
  get: (target, key, receiver) => key === "now" ? () => instant : Reflect.get(target, key, receiver),
});
