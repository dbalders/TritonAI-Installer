import assert from "node:assert/strict";
import { collectPublicationTimes } from "./verify-npm-age";

async function main() {
  const packages = Array.from({ length: 20 }, (_, i) => ({ name: `fixture-${i}`, version: "1.0.0" }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  const times = await collectPublicationTimes([...packages, packages[0]], async () => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return "2026-01-01T00:00:00Z";
  });
  assert.equal(times.size, 20);
  assert.equal(calls, 20, "duplicate package versions must share a lookup");
  assert.ok(peak > 1 && peak <= 6, "lookups should overlap without flooding the registry");
  assert.equal(times.get("fixture-19@1.0.0"), "2026-01-01T00:00:00Z");

  let finished = 0;
  await assert.rejects(collectPublicationTimes(packages, async (name) => {
    if (name === "fixture-0") throw new Error("registry unavailable");
    await new Promise<void>(resolve => setImmediate(resolve));
    finished++;
    return null;
  }), /registry unavailable/);
  assert.equal(finished, 5, "drain in-flight lookups and stop scheduling after a failure");
  const missing = await collectPublicationTimes([packages[0]], async () => null);
  assert.equal(missing.get("fixture-0@1.0.0"), null, "missing dates must reach the policy check");
  console.log("Bounded npm publication lookup tests passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
