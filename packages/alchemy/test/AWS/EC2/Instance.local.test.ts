/**
 * Hosted `AWS.EC2.Instance` under `alchemy dev`: the dualized EC2 providers
 * deploy the fleet (VPC, security group, instance, S3 bundle) into the
 * floci emulator. The instance runs as a real docker container that boots
 * Alchemy userData and serves the hosted `{ fetch }` program.
 *
 * Proof:
 *   - `instance.url` is the emulator's `.localhost.floci.io` address (the
 *     live cloud can never mint it);
 *   - HTTP against that URL serves THIS build's marker from inside the
 *     emulated instance (floci's per-port host-routing mux);
 *   - destroy terminates the instance (out-of-band via distilled).
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { dockerAvailable } from "../Local/fixtures/raw.ts";
import DevInstance, { MARKER } from "./fixtures/dev-instance.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const flociContext = Layer.mergeAll(
  Endpoint.of("http://localhost:4566"),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

test.provider.skipIf(!dockerAvailable)(
  "dev serves a hosted EC2 instance at a reachable url",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* DevInstance;
          return {
            instanceId: instance.instanceId,
            url: instance.url,
          };
        }),
      );

      expect(outputs.instanceId).toMatch(/^i-/);
      expect(outputs.url).toBeTruthy();
      expect(outputs.url).toContain(".localhost.floci.io");
      const base = outputs.url!;

      const served = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.map((res) => res.status === 200),
        Effect.catch(() => Effect.succeed(false)),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (ok): boolean => ok,
          times: 60,
        }),
      );
      expect(served).toBe(true);

      const marker = yield* HttpClient.get(`${base}/marker`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
      );
      expect(marker).toBe(MARKER);

      yield* stack.destroy();
      const gone = yield* ec2
        .describeInstances({ InstanceIds: [outputs.instanceId] })
        .pipe(
          Effect.map((res) => {
            const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name;
            return state === undefined || state === "terminated";
          }),
          Effect.catchTag("InvalidInstanceID.NotFound", () =>
            Effect.succeed(true),
          ),
          Effect.provide(flociContext),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isGone): boolean => isGone,
            times: 30,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 300_000 },
);
