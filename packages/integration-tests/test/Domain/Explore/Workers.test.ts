import { run } from "@alchemy.run/domain/Explore";
/** Workers: 1 and N workers give the same counts and traces; a config mismatch is refused. */
import { describe, expect, it } from "@alchemy.run/test";
import * as M from "./Models.ts";
import { spiScenario } from "./Spi.model.ts";

const url = new URL("./Fixture.worker.ts", import.meta.url).href;

describe("workers", () => {
  for (const [name, scenario] of [
    ["job2", M.jobScenario({ ids: ["J1", "J2"], redeliveries: 1, rules: [M.JOB_ARMED] })],
    ["spi", spiScenario({ fails: 1 })],
  ] as const)
    it(`${name}: 1 worker = 3 workers (counts, verdicts, traces), small batches`, async () => {
      const one = await run(scenario, { batch: 4 });
      const three = await run(scenario, { batch: 4, workers: { count: 3, url, init: { name } } });
      expect(three.engineErrors).toEqual([]);
      expect([three.states, three.transitions, three.coverage._tag]).toEqual([
        one.states,
        one.transitions,
        one.coverage._tag,
      ]);
      expect(three.violations.map((v) => v.trace)).toEqual(one.violations.map((v) => v.trace));
    });

  it("a worker that builds another scenario is refused (fingerprint)", async () => {
    await expect(
      run(M.jobScenario({ ids: ["J1", "J2"] }), {
        workers: { count: 2, url, init: { name: "spi" } },
      }),
    ).rejects.toThrow(/another config/);
  });
});
