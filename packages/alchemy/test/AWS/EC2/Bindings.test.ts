import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import Ec2BindingsFunctionLive, {
  Ec2BindingsFunction,
} from "./fixtures/bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Ec2Bindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

// A `type` (not `interface`) so it carries an implicit index signature and is
// comparable to the `JsonObject` member of `response.json`'s union.
type RouteResult = {
  ok: boolean;
  tag: string;
  state?: string;
  count?: number;
  hasField?: boolean;
  redacted?: boolean | null;
  snapshotId?: string;
};

// Call a fixture route, repeating (bounded) while the response still shows an
// authorization failure — a freshly attached IAM policy is eventually
// consistent and the first invocations after deploy can see EC2's
// `UnauthorizedOperation`.
const callRoute = (method: "GET" | "POST", path: string) =>
  Effect.gen(function* () {
    const request =
      method === "GET"
        ? HttpClientRequest.get(`${baseUrl}${path}`)
        : HttpClientRequest.post(`${baseUrl}${path}`);
    return yield* HttpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.fail(
              new Error(`Route ${path} not ready: ${response.status}`),
            ),
      ),
      Effect.map((json) => json as RouteResult),
      Effect.repeat({
        until: (body): boolean =>
          body.tag !== "UnauthorizedOperation" &&
          body.tag !== "AccessDenied" &&
          body.tag !== "AccessDeniedException",
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
    );
  });

// Deploys a Lambda bound to a real t3.micro instance, a 1 GiB volume, and an
// empty security group, with every EC2 runtime binding plus the instance
// state-change EventBridge subscription. Every route reports the typed result
// tag; `/stop` runs last since it powers the instance off.
describe("EC2 runtime bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { fn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const fn = yield* Ec2BindingsFunction;
          return { fn };
        }).pipe(Effect.provide(Ec2BindingsFunctionLive)),
      );

      expect(fn.functionUrl).toBeTruthy();
      baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 420_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  test.provider(
    "DescribeInstance returns the bound instance's live state",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/describe");
        expect(body.ok).toBe(true);
        expect(body.state).toBeTruthy();
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "DescribeInstanceStatus lists the bound instance's status checks",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/status");
        expect(body.ok).toBe(true);
        expect(body.count).toBeGreaterThanOrEqual(1);
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "GetConsoleOutput fetches the instance's console output",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/console");
        expect(body.ok).toBe(true);
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "GetPasswordData succeeds and surfaces PasswordData as Redacted",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/password");
        expect(body.ok).toBe(true);
        // Linux without a key pair: the field is either absent or Redacted —
        // never a raw string.
        if (body.hasField) {
          expect(body.redacted).toBe(true);
        }
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "StartInstance succeeds against the already-running instance",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/start");
        expect(body.ok).toBe(true);
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "RebootInstance requests an asynchronous reboot",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/reboot");
        expect(body.ok).toBe(true);
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "Authorize/RevokeSecurityGroupIngress round-trip a dynamic rule",
    (_stack) =>
      Effect.gen(function* () {
        // A failed earlier run may have left the rule behind: authorize then
        // tolerates the duplicate, revoke always finds one to remove.
        const authorize = yield* callRoute("POST", "/authorize");
        expect(["Success", "InvalidPermission.Duplicate"]).toContain(
          authorize.tag,
        );
        const revoke = yield* callRoute("POST", "/revoke");
        expect(revoke.tag).toEqual("Success");
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "CreateSnapshot snapshots the bound volume",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/snapshot");
        expect(body.ok).toBe(true);
        expect(body.snapshotId).toBeTruthy();

        // The runtime-created snapshot is not stack-managed — delete it
        // out-of-band so the test leaves zero orphans (pending snapshots can
        // be deleted).
        yield* ec2.deleteSnapshot({ SnapshotId: body.snapshotId! }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("3 seconds"),
            times: 8,
          }),
        );
      }),
    { timeout: 90_000 },
  );

  test.provider(
    "consumeInstanceStateEvents created the EventBridge rule",
    (_stack) =>
      Effect.gen(function* () {
        // The rule's physical name embeds the fixture's logical id
        // (`BindingsInstance-InstanceState`); find it on the default bus with
        // bounded manual pagination.
        let rule: eventbridge.Rule | undefined;
        let nextToken: string | undefined;
        for (let page = 0; page < 10 && !rule; page++) {
          const result = yield* eventbridge.listRules({
            NextToken: nextToken,
          });
          rule = (result.Rules ?? []).find((candidate) =>
            candidate.Name?.includes("InstanceState"),
          );
          nextToken = result.NextToken;
          if (!nextToken) break;
        }
        expect(rule).toBeDefined();
        expect(rule?.EventPattern).toContain("aws.ec2");
        expect(rule?.EventPattern).toContain(
          "EC2 Instance State-change Notification",
        );
      }),
    { timeout: 60_000 },
  );

  // Runs last: the instance stays stopped until the stack is destroyed.
  test.provider(
    "StopInstance powers the instance off",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/stop");
        expect(body.ok).toBe(true);
        expect(["stopping", "stopped"]).toContain(body.state);
      }),
    { timeout: 90_000 },
  );
});
