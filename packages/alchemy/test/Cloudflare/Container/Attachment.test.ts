import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import type { ContainerApplication } from "@/Cloudflare/Containers/ContainerApplication.ts";
import { ContainerPlatform } from "@/Cloudflare/Containers/ContainerPlatform.ts";
import { LiveContainerProvider } from "@/Cloudflare/Containers/ContainerProvider.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import { noopSession } from "@/Report.ts";
import type { ResourceBinding } from "@/Resource.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const accountId = "0123456789abcdef0123456789abcdef";
const image = `registry.cloudflare.com/${accountId}/attachment@sha256:${"a".repeat(64)}`;
const name = "attachment-application";
const applicationsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`;
const configuration = {
  image,
  instanceType: "lite" as const,
  environmentVariables: [
    { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId },
  ],
};
const cached: ContainerApplication["Attributes"] = {
  accountId,
  applicationId: "application-id",
  applicationName: name,
  schedulingPolicy: "default",
  instances: 0,
  maxInstances: 20,
  constraints: {},
  affinities: undefined,
  configuration,
  durableObjects: { namespaceId: "cached-namespace" },
  createdAt: "2026-01-01T00:00:00Z",
  version: 1,
  dev: undefined,
};

// The Worker map is typed as Record<string, string>, but a persisted empty
// map makes its binding projection return undefined at runtime (#1150).
const staleWorkerNamespaces: Record<string, string> = {};
const unresolvedBindings: ResourceBinding<ContainerApplication["Binding"]>[] = [
  {
    sid: "Worker",
    data: {
      durableObjects: { namespaceId: staleWorkerNamespaces.ContainerClass },
    },
  },
];
const input = {
  id: "Application",
  fqn: "Application",
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: { name, image, className: "ContainerClass" },
  news: { name, image, className: "ContainerClass" },
  bindings: unresolvedBindings,
  session: { ...noopSession, note: () => Effect.void },
};
const environment = Layer.mergeAll(
  Layer.succeed(AlchemyContext, {
    dotAlchemy: ".alchemy-test",
    dev: false,
    adopt: false,
  }),
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("test-token"),
      accountId,
      source: { type: "env" },
    }),
  ),
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
  ),
  Layer.succeed(Stack, {
    name: "AttachmentTest",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.sync(ArtifactStore, createArtifactStore),
  Layer.succeed(Stage, "test"),
  NodeServices.layer,
);
const docker = DockerLive.pipe(
  Layer.provide(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Unexpected Docker command")),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const harness = (state: "live" | "ghost" | "missing") => {
  const requests: {
    method: string;
    url: string;
    body?: Record<string, unknown>;
  }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Record(Schema.String, Schema.Unknown),
              ),
            )(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, url: request.url, body });
      // Namespace listing is deliberately outside this recording transport:
      // even one same-class namespace elsewhere in the account is not an owner.
      expect([
        applicationsUrl,
        `${applicationsUrl}/${cached.applicationId}`,
      ]).toContain(request.url);
      expect(["GET", "PATCH", "POST"]).toContain(request.method);
      if (
        (request.method === "GET" &&
          request.url !== applicationsUrl &&
          state === "missing") ||
        (request.method === "PATCH" && state === "ghost")
      ) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              success: false,
              errors: [
                { code: 1609, message: "Container application not found" },
              ],
              messages: [],
              result: null,
            },
            { status: 404 },
          ),
        );
      }
      const application = {
        id: request.method === "POST" ? "recreated-id" : cached.applicationId,
        name,
        account_id: accountId,
        scheduling_policy: "default",
        instances: 0,
        max_instances: 20,
        constraints: {},
        configuration: {
          image,
          instance_type: "lite",
          environment_variables: configuration.environmentVariables,
        },
        durable_objects:
          request.method === "POST"
            ? body?.durable_objects
            : { namespace_id: "live-namespace" },
        created_at: cached.createdAt,
        version: 1,
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result:
            request.method === "GET" && request.url === applicationsUrl
              ? []
              : application,
        }),
      );
    }),
  );
  return {
    requests,
    layer: LiveContainerProvider().pipe(
      Layer.provide(docker),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provideMerge(environment),
    ),
  };
};

describe("unresolved container attachments", () => {
  // Regression: https://github.com/reve-ai/kommunikasie/commit/4b7b11bd
  // The existing upstream fix is https://github.com/alchemy-run/alchemy/pull/1150.
  it.effect(
    "preserves the live namespace when cached and incoming bindings are stale",
    () => {
      const { requests, layer } = harness("live");
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const output = yield* provider.reconcile({ ...input, output: cached });
        expect(output.applicationId).toBe(cached.applicationId);
        expect(output.durableObjects).toEqual({
          namespaceId: "live-namespace",
        });
        expect(requests.map((request) => request.method)).toEqual([
          "GET",
          "PATCH",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "keeps the observed namespace through an update-to-create recovery",
    () => {
      const { requests, layer } = harness("ghost");
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        // Advance each retry delay after the HTTP response has been decoded;
        // a single early adjustment would race the asynchronous response body.
        const output = yield* provider
          .reconcile({ ...input, output: cached })
          .pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: clock.adjust,
            }),
          );
        expect(output.applicationId).toBe("recreated-id");
        expect(output.durableObjects).toEqual({
          namespaceId: "live-namespace",
        });
        const creates = requests.filter((request) => request.method === "POST");
        expect(creates).toHaveLength(1);
        expect(creates[0].body?.durable_objects).toEqual({
          namespace_id: "live-namespace",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "recreates a missing application with its cached exact namespace",
    () => {
      const { requests, layer } = harness("missing");
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const output = yield* provider.reconcile({ ...input, output: cached });
        expect(output.applicationId).toBe("recreated-id");
        expect(output.durableObjects).toEqual(cached.durableObjects);
        const creates = requests.filter((request) => request.method === "POST");
        expect(creates).toHaveLength(1);
        expect(creates[0].body?.durable_objects).toEqual({
          namespace_id: "cached-namespace",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "refuses an unresolved binding when no namespace was recorded",
    () => {
      const { requests, layer } = harness("missing");
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const result = yield* provider
          .reconcile({ ...input, output: undefined })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain("unresolved");
        }
        expect(requests.every((request) => request.method === "GET")).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "still creates a standalone application without a DO binding",
    () => {
      const { requests, layer } = harness("missing");
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const output = yield* provider.reconcile({
          ...input,
          bindings: [],
          output: undefined,
        });
        expect(output.applicationId).toBe("recreated-id");
        expect(output.durableObjects).toBeUndefined();
        expect(
          requests.filter((request) => request.method === "POST"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
