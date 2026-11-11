import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:timestream", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (DB instance, database, scheduled query, table).
// The testing account can't use Timestream; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_TIMESTREAM)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-database": AWS.Timestream.Database.lookup({ databaseName: name }).databaseName,
        "missing-db-instance": AWS.Timestream.DbInstance.lookup({ id: "aaaaaaaaaa" }).id,
        "missing-scheduled-query": AWS.Timestream.ScheduledQuery.lookup({
          scheduledQueryArn: `arn:aws:iam::000000000000:role/${name}`,
        }).scheduledQueryArn,
        "missing-table": AWS.Timestream.Table.lookup({ databaseName: name, tableName: name })
          .tableName,
      });
    }),
  { tags, timeout: 180_000 },
);
