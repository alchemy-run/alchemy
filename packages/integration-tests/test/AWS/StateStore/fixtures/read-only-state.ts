import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * A stack on the state store the test names in its environment, for
 * running `alchemy plan` and `alchemy drift` as a read-only role.
 */
const env = process.env;

export default Alchemy.Stack(
  "ReadOnlyState",
  {
    providers: AWS.providers(),
    state:
      env.READ_ONLY_STATE_TABLE === undefined
        ? AWS.state({ backend: "s3", bucketName: env.READ_ONLY_STATE_BUCKET!, prefix: "read-only" })
        : AWS.state({
            tableName: env.READ_ONLY_STATE_TABLE,
            overflowBucketName: env.READ_ONLY_STATE_BUCKET!,
            migrateFrom: false,
          }),
  },
  Effect.succeed({}),
);
