import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * A stack on the S3 state store in the bucket the test names, for running
 * `alchemy plan` and `alchemy drift` against it as a read-only role.
 */
export default Alchemy.Stack(
  "S3ReadOnlyState",
  {
    providers: AWS.providers(),
    state: AWS.state({
      backend: "s3",
      bucketName: process.env.READ_ONLY_STATE_BUCKET!,
      prefix: "read-only",
    }),
  },
  Effect.succeed({}),
);
