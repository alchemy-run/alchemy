import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { assertDevAccount } from "./guard.ts";
import { BACKEND_IMAGE } from "./support.ts";

// A shared platform needs a stage that fits in a hostname.
const { test } = Test.make({ providers: Convex.providers(), stage: "stackref" });

const bucket = { name: "bucket", arn: "arn:aws:s3:::bucket" };

// What a stage gets from `Platform.stage.dev`: every field is an Output.
const platform = Output.literal({
  domain: "convex-stackref.alchemy",
  hostedZoneId: "Z123",
  vpcId: "vpc-123",
  subnetId: "subnet-123",
  clusterArn: "arn:aws:ecs:eu-central-1:123456789012:cluster/convex",
  listenerArn: "arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/convex/1/1",
  albDnsName: "convex.eu-central-1.elb.amazonaws.com",
  albZoneId: "Z215JYRZR1TBD5",
  backendSecurityGroupId: "sg-123",
  storage: {
    files: bucket,
    modules: bucket,
    exports: bucket,
    snapshotImports: bucket,
    search: bucket,
  },
  database: {
    engine: "postgres" as const,
    host: "db.example.com",
    port: 5432,
    username: "convex_admin",
    passwordParameterName: "/convex/password",
    runnerFunctionName: "convex-runner",
  },
}) as unknown as Convex.PlatformHandle;

// Plans only, so this creates nothing and costs nothing.
test.provider.skipIf(process.env.CONVEX_TEST_AWS !== "1")(
  "a backend plans from another stack's platform",
  (stack) =>
    Effect.gen(function* () {
      yield* assertDevAccount;
      const plan = yield* stack.plan(
        Convex.Backend("Backend", { platform, image: BACKEND_IMAGE, cpu: 512, memory: 1024 }),
      );
      expect(Object.keys(plan.resources).length).toBeGreaterThan(0);
    }),
);
