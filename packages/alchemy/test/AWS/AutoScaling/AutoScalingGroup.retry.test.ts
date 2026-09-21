import {
  AutoScalingGroup,
  AutoScalingGroupProvider,
} from "@/AWS/AutoScaling/AutoScalingGroup.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Retry from "@distilled.cloud/aws/Retry";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const propagationMessage =
  "You must use a valid fully-formed launch template. Value (test-profile) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name";

const fixture = (failures: number, code: string, message: string) => {
  const calls: string[] = [];
  let attempts = 0;
  let exists = false;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array") {
        throw new Error("Expected an AWS Query request body");
      }
      const body = new URLSearchParams(
        new TextDecoder().decode(request.body.body),
      );
      const action = body.get("Action")!;
      calls.push(action);
      let status = 200;
      let response = `<${action}Response><${action}Result/></${action}Response>`;
      if (action === "CreateAutoScalingGroup") {
        attempts++;
        expect(body.get("AutoScalingGroupName")).toBe("profile-retry");
        expect(body.get("LaunchTemplate.LaunchTemplateId")).toBe("lt-test");
        if (attempts <= failures) {
          exists = code === "AlreadyExists";
          status = 400;
          response = `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>test</RequestId></ErrorResponse>`;
        } else {
          exists = true;
        }
      } else if (action === "DescribeAutoScalingGroups") {
        const group = exists
          ? "<member><AutoScalingGroupName>profile-retry</AutoScalingGroupName><AutoScalingGroupARN>arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:test:autoScalingGroupName/profile-retry</AutoScalingGroupARN><MinSize>0</MinSize><MaxSize>0</MaxSize><DesiredCapacity>0</DesiredCapacity><VPCZoneIdentifier>subnet-test</VPCZoneIdentifier><LaunchTemplate><LaunchTemplateId>lt-test</LaunchTemplateId><Version>$Default</Version></LaunchTemplate></member>"
          : "";
        response = `<DescribeAutoScalingGroupsResponse><DescribeAutoScalingGroupsResult><AutoScalingGroups>${group}</AutoScalingGroups></DescribeAutoScalingGroupsResult></DescribeAutoScalingGroupsResponse>`;
      } else {
        expect(["UpdateAutoScalingGroup", "CreateOrUpdateTags"]).toContain(
          action,
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(response, {
          status,
          headers: { "content-type": "text/xml" },
        }),
      );
    }),
  );
  const reconcile = Effect.gen(function* () {
    const provider = yield* Provider.Provider<AutoScalingGroup>(
      AutoScalingGroup.Type,
    );
    return yield* provider.reconcile({
      id: "Group",
      fqn: "Group",
      instanceId: "test",
      news: {
        autoScalingGroupName: "profile-retry",
        launchTemplate: { launchTemplateId: "lt-test" },
        subnetIds: ["subnet-test"],
        minSize: 0,
        maxSize: 0,
      },
      olds: undefined,
      output: undefined,
      bindings: [],
      session: {
        emit: () => Effect.void,
        done: () => Effect.void,
        note: () => Effect.void,
      },
    });
  }).pipe(
    Effect.provide(AutoScalingGroupProvider()),
    Retry.none,
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(
          Credentials,
          Effect.succeed({
            accessKeyId: Redacted.make("AKIATEST"),
            secretAccessKey: Redacted.make("test-secret"),
            sessionToken: undefined,
            region: "us-east-1" as const,
          }),
        ),
        Layer.succeed(Stage, "test"),
        Layer.succeed(Stack, {
          name: "asg-retry",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
      ),
    ),
  );
  return { calls, reconcile, attempts: () => attempts };
};

describe("AutoScalingGroup instance profile propagation", () => {
  it.live("retries a not-yet-visible profile and then reconciles", () =>
    Effect.gen(function* () {
      const test = fixture(2, "ValidationError", propagationMessage);
      const group = yield* test.reconcile;
      expect(test.attempts()).toBe(3);
      expect(group.autoScalingGroupName).toBe("profile-retry");
      expect(test.calls).toContain("UpdateAutoScalingGroup");
    }),
  );

  for (const message of [
    "The specified launch template does not exist",
    "iamInstanceProfile.name is invalid. Invalid IAM Instance Profile ARN",
  ]) {
    it.live(`does not retry unrelated validation: ${message}`, () =>
      Effect.gen(function* () {
        const test = fixture(9, "ValidationError", message);
        const result = yield* test.reconcile.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ValidationError");
          expect(result.failure.message).toBe(message);
        }
        expect(test.attempts()).toBe(1);
        expect(test.calls).not.toContain("UpdateAutoScalingGroup");
      }),
    );
  }

  it.live("does not retry a matching message with another error tag", () =>
    Effect.gen(function* () {
      const test = fixture(9, "AccessDenied", propagationMessage);
      const result = yield* test.reconcile.pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("AccessDeniedException");
      }
      expect(test.attempts()).toBe(1);
    }),
  );

  it.live("stops after eight retries when the profile remains invalid", () =>
    Effect.gen(function* () {
      const test = fixture(10, "ValidationError", propagationMessage);
      const result = yield* test.reconcile.pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ValidationError");
        expect(result.failure.message).toBe(propagationMessage);
      }
      expect(test.attempts()).toBe(9);
      expect(test.calls).not.toContain("UpdateAutoScalingGroup");
    }),
  );

  it.live("continues reconciliation on an AlreadyExistsFault race", () =>
    Effect.gen(function* () {
      const test = fixture(1, "AlreadyExists", "Group already exists");
      const group = yield* test.reconcile;
      expect(test.attempts()).toBe(1);
      expect(group.autoScalingGroupName).toBe("profile-retry");
      expect(test.calls).toContain("UpdateAutoScalingGroup");
    }),
  );
});
