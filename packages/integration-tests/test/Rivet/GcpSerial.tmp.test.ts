import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

test.provider("dump rivet serial output", () =>
  Effect.gen(function* () {
    const { project, region } = yield* GcpEnvironment.current;
    const out: string[] = [];
    for (const zone of [`${region}-a`, `${region}-b`, `${region}-c`]) {
      const list = yield* compute.listInstances({ project, zone });
      for (const inst of list.items ?? []) {
        out.push(`name ${inst.name} ip ${inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP}`); if (!(inst.labels && Object.values(inst.labels).some((v) => /rivet/i.test(String(v)))) && !/rivet/i.test(inst.name ?? "")) continue;
        const serial = yield* compute.getSerialPortOutputInstances({ project, zone, instance: inst.name! });
        const lines = (serial.contents ?? "").split("\n");
        out.push(`=== ${inst.name} ${zone}`, ...lines.filter((l) => /rivet-engine:/.test(l) && /admit|reject|refus|connect|unreach|timed out|probe|heartbeat|worker/i.test(l)).slice(-25));
      }
    }
    const fws = yield* compute.listFirewalls({ project });
    for (const fw of fws.items ?? []) {
      if (!/rivet|alch/i.test(fw.name ?? "")) continue;
      out.push(`fw ${fw.name} srcTags=${JSON.stringify(fw.sourceTags)} net=${fw.network} tags=${JSON.stringify(fw.targetTags)} src=${JSON.stringify(fw.sourceRanges)} allowed=${JSON.stringify(fw.allowed)}`);
    }
    for (const zone of [`${region}-a`, `${region}-b`, `${region}-c`]) {
      const list = yield* compute.listInstances({ project, zone });
      for (const inst of list.items ?? []) out.push(`inst ${inst.name} tags=${JSON.stringify(inst.tags?.items)} net=${inst.networkInterfaces?.[0]?.network}`);
    }
    yield* Effect.promise(() => Bun.write("/tmp/gcp-serial.txt", out.join("\n")));
  }),
);
