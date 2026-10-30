/** The worker of the determinism test: it builds a tiny scenario by name. */
import { serveWorker } from "@alchemy.run/domain/Explore";
import * as M from "./Models.ts";
import { spiScenario } from "./Spi.model.ts";

const byName: Record<
  string,
  () => Parameters<typeof serveWorker>[0] extends (i: any) => infer S ? S : never
> = {
  job2: () => M.jobScenario({ ids: ["J1", "J2"], redeliveries: 1, rules: [M.JOB_ARMED] }),
  spi: () => spiScenario({ fails: 1 }),
};
serveWorker((init: { name: string }) => byName[init.name]!());
