import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Temporary diagnostic probe — fetch the Bindings fixture Lambda's logs to
// see the defect behind the plain 'Internal Server Error' 500s.
test.provider(
  "probe: fixture lambda defect logs",
  () =>
    Effect.gen(function* () {
      const out: string[] = [];
      const groups = yield* logs.describeLogGroups({
        logGroupNamePrefix: "/aws/lambda/IoTWirelessBindings",
      });
      out.push(`groups: ${(groups.logGroups ?? []).length}`);
      for (const g of groups.logGroups ?? []) {
        out.push(`GROUP ${g.logGroupName}`);
        const events = yield* logs.filterLogEvents({
          logGroupName: g.logGroupName!,
          filterPattern: "ERROR",
          limit: 15,
        });
        out.push(`events: ${(events.events ?? []).length}`);
        for (const e of events.events ?? []) {
          out.push("-----");
          out.push((e.message ?? "").slice(0, 3000));
        }
      }
      yield* Effect.sync(() =>
        process.stderr.write(`\nPROBE-OUTPUT\n${out.join("\n")}\nPROBE-END\n`),
      );
    }),
  { timeout: 60_000 },
);
