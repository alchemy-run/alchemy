import * as Azure from "@alchemy.run/azure";
import { collectAll } from "@alchemy.run/azure/Arm";
import * as cdn from "@distilled.cloud/azure/cdn";
import { describe } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

describe("zzprobe", () => {
  test.provider(
    "wait until fewer Front Door profiles exist",
    () =>
      Effect.gen(function* () {
        const { subscriptionId } = yield* Azure.AzureEnvironment.current;
        const count = collectAll(cdn.ListProfiles, { subscriptionId }).pipe(
          Effect.map((r) => r.value.filter((p) => p.sku?.name?.includes("AzureFrontDoor"))),
          Effect.tap((ps) =>
            Effect.sync(() =>
              console.log("PROBE profiles", ps.length, ps.map((p) => `${p.name}:${p.properties?.provisioningState}`).join(" ")),
            ),
          ),
        );
        yield* count.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("60 seconds"),
            until: (ps) => ps.length <= Number(process.env.PROBE_MAX ?? 4),
            times: 40,
          }),
        );
      }),
    { timeout: 2_700_000 },
  );
});
