import { Assets } from "@/AWS/Assets.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import {
  LaunchTemplate,
  LaunchTemplateProvider,
} from "@/AWS/AutoScaling/LaunchTemplate.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as Retry from "@distilled.cloud/aws/Retry";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const id = "lt-0ac8192309244d619";
const input = {
  id: "Template",
  fqn: "Template",
  instanceId: "test",
  olds: {
    launchTemplateName: "cleanup-test",
    imageId: "ami-test",
    instanceType: "t3.micro",
  },
  output: {
    launchTemplateId: id,
    launchTemplateName: "cleanup-test",
    launchTemplateArn: `arn:aws:ec2:us-west-2:123456789012:launch-template/${id}`,
    defaultVersionNumber: 1,
    latestVersionNumber: 1,
    tags: {},
    roleName: "cleanup-role",
    policyName: "cleanup-policy",
  } satisfies LaunchTemplate["Attributes"],
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};

const fixture = (code?: string) => {
  const calls: string[] = [];
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
      if (action === "DeleteRolePolicy") {
        expect(body.get("RoleName")).toBe("cleanup-role");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            "<DeleteRolePolicyResponse><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></DeleteRolePolicyResponse>",
            { headers: { "content-type": "text/xml" } },
          ),
        );
      }
      expect(["DescribeLaunchTemplates", "DeleteLaunchTemplate"]).toContain(
        action,
      );
      const byName = body.has("LaunchTemplateName.1");
      if (!byName) {
        expect(
          body.get(
            action === "DescribeLaunchTemplates"
              ? "LaunchTemplateId.1"
              : "LaunchTemplateId",
          ),
        ).toBe(id);
      }
      const error =
        code ??
        (byName
          ? "InvalidLaunchTemplateName.NotFoundException"
          : "InvalidLaunchTemplateId.NotFound");
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          `<Response><Errors><Error><Code>${error}</Code><Message>The specified launch template does not exist.</Message></Error></Errors><RequestID>test</RequestID></Response>`,
          { status: 400, headers: { "content-type": "text/xml" } },
        ),
      );
    }),
  );
  const credentials = Effect.succeed({
    accessKeyId: Redacted.make("AKIATEST"),
    secretAccessKey: Redacted.make("test-secret"),
    sessionToken: undefined,
    region: "us-west-2" as const,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Credentials, credentials),
    Layer.succeed(Region, Effect.succeed("us-west-2")),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: "123456789012",
        region: "us-west-2",
        credentials,
      }),
    ),
    Layer.succeed(Assets, {
      bucketName: Effect.succeed("launch-template-cleanup-assets"),
      uploadAsset: () =>
        Effect.die(new Error("Unexpected asset upload during cleanup")),
      hasAsset: () =>
        Effect.die(new Error("Unexpected asset lookup during cleanup")),
    }),
    FileSystem.layerNoop({}),
    Path.layer,
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "launch-template-cleanup",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
  );
  const provider = Provider.Provider<LaunchTemplate>(LaunchTemplate.Type);
  const read = Effect.flatMap(provider, (provider) => {
    if (!provider.read) {
      return Effect.die(
        new Error("LaunchTemplate provider must implement read"),
      );
    }
    return provider.read(input);
  }).pipe(
    Retry.none,
    Effect.provide(LaunchTemplateProvider().pipe(Layer.provideMerge(layer))),
  );
  const remove = Effect.flatMap(provider, (provider) =>
    provider.delete(input),
  ).pipe(
    Retry.none,
    Effect.provide(LaunchTemplateProvider().pipe(Layer.provideMerge(layer))),
  );
  return { calls, read, remove };
};

describe("LaunchTemplate absent resource cleanup", () => {
  it.effect("reads an absent ID and name as missing", () =>
    Effect.gen(function* () {
      const test = fixture();
      expect(yield* test.read).toBeUndefined();
      expect(test.calls).toEqual([
        "DescribeLaunchTemplates",
        "DescribeLaunchTemplates",
      ]);
    }),
  );

  it.effect(
    "repeated delete tolerates an absent ID and continues hosted cleanup",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        yield* test.remove;
        yield* test.remove;
        expect(test.calls).toEqual([
          "DeleteLaunchTemplate",
          "DeleteRolePolicy",
          "DeleteLaunchTemplate",
          "DeleteRolePolicy",
        ]);
      }),
  );

  it.effect(
    "does not suppress unauthorized delete or clean up hosted resources",
    () =>
      Effect.gen(function* () {
        const test = fixture("UnauthorizedOperation");
        const result = yield* test.remove.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure._tag).toBe("UnauthorizedOperation");
        expect(test.calls).toEqual(["DeleteLaunchTemplate"]);
      }),
  );

  it.effect("does not treat a malformed ID as an absent resource", () =>
    Effect.gen(function* () {
      const test = fixture("InvalidLaunchTemplateId.Malformed");
      const result = yield* test.read.pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure._tag).toBe("InvalidLaunchTemplateId.Malformed");
      expect(test.calls).toEqual(["DescribeLaunchTemplates"]);
    }),
  );
});
