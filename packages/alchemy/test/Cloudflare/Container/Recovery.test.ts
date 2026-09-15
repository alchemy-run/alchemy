import { Unowned } from "@/AdoptPolicy.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { ContainerPlatform } from "@/Cloudflare/Containers/ContainerPlatform.ts";
import { LiveContainerProvider } from "@/Cloudflare/Containers/ContainerProvider.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import { InstanceId } from "@/InstanceId.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const accountId = "0123456789abcdef0123456789abcdef";
const instanceId = "00000000000000000000000000000000";
const image = `registry.cloudflare.com/${accountId}/recovery@sha256:${"a".repeat(64)}`;
// The zero-valued persisted instance has a 16-character base32 suffix.
const generatedName = "recovery-application-test-aaaaaaaaaaaaaaaa";
const applicationsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`;
const application = {
  id: "application-id",
  name: generatedName,
  account_id: accountId,
  scheduling_policy: "default",
  instances: 0,
  max_instances: 20,
  constraints: {},
  configuration: {
    image,
    instance_type: "lite",
    environment_variables: [
      { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId },
    ],
  },
  created_at: "2026-01-01T00:00:00Z",
  version: 1,
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
    name: "Recovery",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.sync(ArtifactStore, createArtifactStore),
  Layer.succeed(Stage, "test"),
  Layer.succeed(InstanceId, instanceId),
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

const harness = (observed: typeof application) => {
  const requests: { method: string; url: string }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ method: request.method, url: request.url });
      expect(request.method).toBe("GET");
      expect(request.url).toBe(applicationsUrl);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [observed],
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

describe("interrupted container creation", () => {
  // Regression: https://github.com/reve-ai/kommunikasie/commit/f2e7320ff261833092b84d8aa25e3563710661e8
  const cases = [
    {
      title: "recovers the persisted generated instance",
      recovery: "interrupted-create" as const,
      expected: "owned",
    },
    {
      title: "keeps ordinary generated-name discovery unowned",
      expected: "unowned",
    },
    {
      title:
        "keeps explicit names unowned during recovery even with identical configuration",
      name: generatedName,
      recovery: "interrupted-create" as const,
      expected: "unowned",
    },
    {
      title: "keeps ordinary explicit-name discovery unowned",
      name: generatedName,
      expected: "unowned",
    },
    {
      title: "does not recover the generated name from another account",
      recovery: "interrupted-create" as const,
      observed: {
        ...application,
        account_id: "fedcba9876543210fedcba9876543210",
      },
      expected: "unowned",
    },
    {
      title: "does not recover another generated instance",
      recovery: "interrupted-create" as const,
      observed: {
        ...application,
        name: "recovery-application-test-7777777777777777",
      },
      expected: "missing",
    },
  ];
  for (const scenario of cases) {
    it.effect(scenario.title, () => {
      const { requests, layer } = harness(scenario.observed ?? application);
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const input = {
          id: "Application",
          fqn: "Application",
          instanceId,
          olds: { name: scenario.name, image },
          output: undefined,
          recovery: scenario.recovery,
        };
        const output = yield* provider.read!(input);
        if (scenario.expected === "missing") {
          expect(output).toBeUndefined();
        } else {
          expect(output?.applicationName).toBe(generatedName);
          expect(Unowned.is(output)).toBe(scenario.expected === "unowned");
        }
        expect(requests).toEqual([{ method: "GET", url: applicationsUrl }]);
      }).pipe(Effect.provide(layer));
    });
  }

  it.effect(
    "recovers server-enriched and autoscaled state for subsequent diff",
    () => {
      const { layer } = harness({
        ...application,
        instances: 3,
        configuration: {
          ...application.configuration,
          environment_variables: [
            ...application.configuration.environment_variables,
            { name: "SERVER_DEFAULT", value: "added-after-create" },
          ],
        },
      });
      return Effect.gen(function* () {
        const provider = yield* ContainerPlatform.Provider;
        const input = {
          id: "Application",
          fqn: "Application",
          instanceId,
          olds: { image },
          output: undefined,
          recovery: "interrupted-create" as const,
        };
        const output = yield* provider.read!(input);
        expect(output?.instances).toBe(3);
        expect(output?.configuration.environmentVariables).toContainEqual({
          name: "SERVER_DEFAULT",
          value: "added-after-create",
        });
        expect(Unowned.is(output)).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
});
