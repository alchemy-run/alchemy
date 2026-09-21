import { Unowned } from "@/AdoptPolicy.ts";
import {
  CapacityProvider,
  CapacityProviderProvider,
} from "@/AWS/ECS/CapacityProvider.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Retry from "@distilled.cloud/aws/Retry";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const name = "celld-capacity-recovery";
const arn = `arn:aws:ecs:us-west-2:123456789012:capacity-provider/${name}`;
const oldAsg =
  "arn:aws:autoscaling:us-west-2:123456789012:autoScalingGroup:old:autoScalingGroupName/old";
const newAsg =
  "arn:aws:autoscaling:us-west-2:123456789012:autoScalingGroup:new:autoScalingGroupName/new";
const tags = {
  "alchemy::stack": "capacity-recovery",
  "alchemy::stage": "test",
  "alchemy::id": "Capacity",
};
const news = {
  name,
  autoScalingGroupArn: newAsg,
  managedScaling: { status: "ENABLED", targetCapacity: 80 },
  managedTerminationProtection: "DISABLED",
  managedDraining: "ENABLED",
} satisfies CapacityProvider["Props"];
const input = {
  id: "Capacity",
  fqn: "Cells/Capacity",
  instanceId: "test",
  olds: news,
  output: undefined,
};

type RequestBody = {
  name?: string;
  capacityProviders?: string[];
  include?: string[];
  autoScalingGroupProvider?: Partial<ecs.AutoScalingGroupProvider>;
  tags?: ecs.Tag[];
};

const fixture = (
  options: {
    status?: ecs.CapacityProviderStatus;
    foreign?: boolean;
    fail?:
      | "DescribeCapacityProviders"
      | "CreateCapacityProvider"
      | "UpdateCapacityProvider";
  } = {},
) => {
  const calls: { action: string; body: RequestBody }[] = [];
  let observed: ecs.CapacityProvider = {
    name,
    capacityProviderArn: arn,
    status: options.status ?? "INACTIVE",
    updateStatus:
      options.status === "ACTIVE" ? "UPDATE_COMPLETE" : "DELETE_COMPLETE",
    autoScalingGroupProvider: {
      autoScalingGroupArn: options.status === "ACTIVE" ? newAsg : oldAsg,
    },
    tags:
      options.status === "ACTIVE" && !options.foreign
        ? Object.entries(tags).map(([key, value]) => ({ key, value }))
        : [],
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected an ECS JSON request body");
      const body: RequestBody = JSON.parse(
        new TextDecoder().decode(request.body.body),
      );
      const action = request.headers["x-amz-target"]!.split(".").at(-1)!;
      calls.push({ action, body });
      const response = (value: object, status = 200) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/x-amz-json-1.1" },
          }),
        );
      if (action === options.fail)
        return response(
          {
            __type: "ClientException",
            message: "Capacity provider request rejected",
          },
          400,
        );
      switch (action) {
        case "DescribeCapacityProviders":
          expect(body.capacityProviders).toEqual([name]);
          expect(body.include).toEqual(["TAGS"]);
          return response({ capacityProviders: [observed], failures: [] });
        case "CreateCapacityProvider":
          expect(observed.status).toBe("INACTIVE");
          expect(body.name).toBe(name);
          expect(body.autoScalingGroupProvider?.autoScalingGroupArn).toBe(
            newAsg,
          );
          expect(body.tags).toEqual(
            Object.entries(tags).map(([key, value]) => ({ key, value })),
          );
          observed = {
            ...observed,
            status: "ACTIVE",
            updateStatus: "UPDATE_COMPLETE",
            autoScalingGroupProvider: {
              autoScalingGroupArn: newAsg,
              ...body.autoScalingGroupProvider,
            },
            tags: body.tags,
          };
          return response({ capacityProvider: observed });
        case "UpdateCapacityProvider":
          expect(observed.status).toBe("ACTIVE");
          expect(body.name).toBe(name);
          observed = {
            ...observed,
            autoScalingGroupProvider: {
              ...observed.autoScalingGroupProvider!,
              ...body.autoScalingGroupProvider,
            },
          };
          return response({ capacityProvider: observed });
        default:
          throw new Error(`Unexpected ECS request: ${action}`);
      }
    }),
  );
  const credentials = Effect.succeed({
    accessKeyId: Redacted.make("AKIATEST"),
    secretAccessKey: Redacted.make("test-secret"),
    sessionToken: undefined,
    region: "us-west-2" as const,
  });
  const layer = CapacityProviderProvider().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
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
        Layer.succeed(Stage, "test"),
        Layer.succeed(Stack, {
          name: "capacity-recovery",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
      ),
    ),
  );
  const provider = Provider.Provider<CapacityProvider>(CapacityProvider.Type);
  const read = Effect.flatMap(provider, (provider) =>
    provider.read!(input),
  ).pipe(Retry.none, Effect.provide(layer));
  const reconcile = Effect.flatMap(provider, (provider) =>
    provider.reconcile({
      ...input,
      news,
      olds: undefined,
      bindings: [],
      session: {
        emit: () => Effect.void,
        done: () => Effect.void,
        note: () => Effect.void,
      },
    }),
  ).pipe(Retry.none, Effect.provide(layer));
  return { calls, read, reconcile };
};

describe("ECS CapacityProvider tombstone recovery", () => {
  it.effect("reads an INACTIVE/DELETE_COMPLETE tombstone as absent", () =>
    Effect.gen(function* () {
      const test = fixture();
      expect(yield* test.read).toBeUndefined();
      expect(test.calls.map((call) => call.action)).toEqual([
        "DescribeCapacityProviders",
      ]);
    }),
  );

  it.effect("recreates a tombstone with the desired ASG before updating", () =>
    Effect.gen(function* () {
      const test = fixture();
      const output = yield* test.reconcile;
      expect(output.status).toBe("ACTIVE");
      expect(output.autoScalingGroupArn).toBe(newAsg);
      expect(output.managedScaling).toEqual(news.managedScaling);
      expect(output.tags).toEqual(tags);
      expect(test.calls.map((call) => call.action)).toEqual([
        "DescribeCapacityProviders",
        "CreateCapacityProvider",
        "DescribeCapacityProviders",
        "UpdateCapacityProvider",
        "DescribeCapacityProviders",
      ]);
    }),
  );

  it.effect("preserves owned ACTIVE read attributes", () =>
    Effect.gen(function* () {
      const test = fixture({ status: "ACTIVE" });
      const output = yield* test.read;
      expect(output?.capacityProviderArn).toBe(arn);
      expect(output?.status).toBe("ACTIVE");
      expect(Unowned.is(output)).toBe(false);
    }),
  );

  it.effect("retains the Unowned guard for foreign ACTIVE providers", () =>
    Effect.gen(function* () {
      const test = fixture({ status: "ACTIVE", foreign: true });
      expect(Unowned.is(yield* test.read)).toBe(true);
      expect(test.calls.map((call) => call.action)).toEqual([
        "DescribeCapacityProviders",
      ]);
    }),
  );

  it.effect("updates an existing ACTIVE provider without recreating it", () =>
    Effect.gen(function* () {
      const test = fixture({ status: "ACTIVE" });
      const output = yield* test.reconcile;
      expect(output.status).toBe("ACTIVE");
      expect(output.autoScalingGroupArn).toBe(newAsg);
      expect(output.managedScaling).toEqual(news.managedScaling);
      expect(test.calls.map((call) => call.action)).toEqual([
        "DescribeCapacityProviders",
        "UpdateCapacityProvider",
        "DescribeCapacityProviders",
      ]);
    }),
  );

  for (const fail of [
    "DescribeCapacityProviders",
    "CreateCapacityProvider",
    "UpdateCapacityProvider",
  ] as const) {
    it.effect(`preserves typed ClientException from ${fail}`, () =>
      Effect.gen(function* () {
        const test = fixture({
          fail,
          status: fail === "UpdateCapacityProvider" ? "ACTIVE" : "INACTIVE",
        });
        const result = yield* test.reconcile.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ClientException");
          expect(result.failure.message).toBe(
            "Capacity provider request rejected",
          );
        }
        expect(test.calls.at(-1)?.action).toBe(fail);
        expect(test.calls.filter((call) => call.action === fail)).toHaveLength(
          1,
        );
      }),
    );
  }
});
