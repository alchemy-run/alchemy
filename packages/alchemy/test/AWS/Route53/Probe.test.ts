import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import { writeFileSync } from "node:fs";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("probe listHostedZones", () =>
  Effect.gen(function* () {
    const createExit = yield* Effect.exit(
      route53.createHostedZone({
        Name: "alchemy-route53-list-test.com.",
        CallerReference: "alchemy-route53-record-list-test",
      }),
    );
    const listExit = yield* Effect.exit(route53.listHostedZones({}));
    yield* Effect.sync(() =>
      writeFileSync(
        "/tmp/route53-probe.json",
        JSON.stringify(
          { createTag: createExit._tag, listExit },
          (_k, v) => (v === undefined ? "<undef>" : v),
          2,
        ),
      ),
    );
  }),
);
