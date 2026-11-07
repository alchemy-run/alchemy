import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:cloudwatch", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (alarm, composite alarm, dashboard, metric stream).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-alarm": AWS.CloudWatch.Alarm.lookup({ alarmName: name }).alarmName,
        "missing-composite-alarm": AWS.CloudWatch.CompositeAlarm.lookup({ alarmName: name })
          .alarmName,
        "missing-dashboard": AWS.CloudWatch.Dashboard.lookup({ dashboardName: name }).dashboardName,
        "missing-metric-stream": AWS.CloudWatch.MetricStream.lookup({ metricStreamName: name })
          .metricStreamName,
      });
    }),
  { tags, timeout: 180_000 },
);
