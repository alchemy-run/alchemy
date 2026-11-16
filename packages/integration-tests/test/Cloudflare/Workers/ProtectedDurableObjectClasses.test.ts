import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { Worker, type WorkerProps } from "@alchemy.run/cloudflare/Workers/Worker";
import {
  LiveWorkerProvider,
  ProtectedDurableObjectClassDeletion,
} from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect, it } from "@alchemy.run/test";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import type { ResourceBinding } from "alchemy/Resource";
import { Stack, type StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const accountId = "a".repeat(32);
const workerName = "protected-do-worker";
const oldBinding = (className: string, logicalId = className): ResourceBinding => ({
  sid: logicalId,
  data: {
    bindings: [{ type: "durable_object_namespace", name: logicalId, className }],
  },
});
const newBinding = (
  className: string,
  options?: { renamedFrom?: string; scriptName?: string },
): ResourceBinding => ({
  sid: className,
  data: {
    bindings: [
      {
        type: "durable_object_namespace",
        name: className,
        className,
        ...options,
      },
    ],
  },
});
const output: Worker["Attributes"] = {
  workerId: "worker-immutable-id",
  workerName,
  namespace: undefined,
  accountId,
  tags: ["alchemy:dos:Counter"],
  durableObjectNamespaces: { Counter: "existing-namespace-id" },
  logpush: undefined,
  url: undefined,
  urls: [],
  domain: undefined,
  routes: [],
  crons: [],
};

const nativeExport = {
  kind: "durableObject" as const,
  constructor: Effect.succeed(Effect.succeed({})),
  services: Context.empty(),
};

const stack: Omit<StackSpec, "output"> = {
  name: "protected-do-class-test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};

// This is the real live Worker provider, not a copied class diff. Any request
// against Cloudflare's API fails the test: the guard must be fully local.
const provider = LiveWorkerProvider().pipe(Layer.provide(Layer.succeed(Stack, stack)));
const noHttp = HttpClient.make(() => Effect.die("Protected DO diff attempted an HTTP request"));

const reconcileWithApi = () => {
  const calls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (request.method !== "GET") {
        throw new Error(
          `Unexpected Cloudflare mutation before protection check: ${request.method} ${path}`,
        );
      }
      if (path.endsWith("/settings") && path.includes("/workers/scripts/")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result: {
              tags: ["alchemy:dos:Counter"],
              bindings: [
                {
                  name: "Counter",
                  type: "durable_object_namespace",
                  className: "Counter",
                  namespaceId: "existing-namespace-id",
                },
              ],
            },
          }),
        );
      }
      if (path.endsWith("/durable_objects/namespaces")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result: [{ id: "existing-namespace-id", class: "Counter", script: workerName }],
            result_info: { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 },
          }),
        );
      }
      throw new Error(`Unmocked Cloudflare read: ${path}`);
    }),
  );
  const result = Effect.gen(function* () {
    const live = yield* Provider.findProvider(Worker);
    return yield* live.reconcile({
      id: "Worker",
      fqn: "Worker",
      instanceId: "test-instance",
      olds: {
        script:
          "export class Counter {}; export default { fetch() { return new Response('ok'); } }",
      },
      news: { script: "export default { fetch() { return new Response('ok'); } }" },
      output,
      bindings: [],
      session: noopSession,
      protected: true,
    });
  }).pipe(
    Effect.provide(provider),
    Effect.provideService(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("never-used"),
        accountId,
        source: { type: "env" as const },
      }),
    ),
    Effect.provideService(
      Credentials,
      Effect.succeed(apiTokenCredentials({ accountId, apiToken: Redacted.make("never-used") })),
    ),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Stage, "test"),
  );
  return { calls, result };
};

const planDiff = (options: {
  protected: boolean;
  olds?: WorkerProps;
  news?: WorkerProps;
  oldBindings?: ResourceBinding[];
  newBindings?: ResourceBinding[];
  output?: Worker["Attributes"];
}) =>
  Effect.gen(function* () {
    const live = yield* Provider.findProvider(Worker);
    return yield* live.diff!({
      id: "Worker",
      fqn: "Worker",
      instanceId: "test-instance",
      olds: options.olds ?? {},
      news: options.news ?? {},
      output: options.output ?? output,
      oldBindings: options.oldBindings ?? [oldBinding("Counter")],
      newBindings: options.newBindings ?? [],
      protected: options.protected,
    });
  }).pipe(
    Effect.provide(provider),
    Effect.provideService(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("never-used"),
        accountId,
        source: { type: "env" as const },
      }),
    ),
    Effect.provideService(
      Credentials,
      Effect.succeed(apiTokenCredentials({ accountId, apiToken: Redacted.make("never-used") })),
    ),
    Effect.provideService(HttpClient.HttpClient, noHttp),
    Effect.provide(NodeServices.layer),
    Effect.provideService(Stage, "test"),
  );

describe(
  "Protected Worker inline Durable Object class deletion",
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    it.effect("rejects removing an existing class before any Cloudflare request", () =>
      Effect.gen(function* () {
        const error = yield* planDiff({ protected: true }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProtectedDurableObjectClassDeletion);
        expect(error).toMatchObject({ classNames: ["Counter"] });
      }),
    );

    it.effect("rejects deleting one class while keeping another binding", () =>
      Effect.gen(function* () {
        const error = yield* planDiff({
          protected: true,
          oldBindings: [oldBinding("Counter"), oldBinding("Retained")],
          newBindings: [newBinding("Retained")],
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ classNames: ["Counter"] });
      }),
    );

    it.effect("checks packed ownership tags even when old binding state is absent", () =>
      Effect.gen(function* () {
        const error = yield* planDiff({
          protected: true,
          oldBindings: [],
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ classNames: ["Counter"] });
      }),
    );

    it.effect("protects Effect-native exports without old bindings or tags", () =>
      Effect.gen(function* () {
        const error = yield* planDiff({
          protected: true,
          olds: { exports: { Counter: nativeExport } },
          oldBindings: [],
          output: { ...output, tags: [] },
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ classNames: ["Counter"] });
      }),
    );

    it.effect("retaining an Effect-native export does not look like deletion", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          olds: { exports: { Counter: nativeExport } },
          news: { name: "different-name", exports: { Counter: nativeExport } },
          oldBindings: [],
          output: { ...output, tags: [] },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("defers protection when desired class exports depend on an unresolved Effect", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          olds: { exports: { Counter: nativeExport } },
          news: {
            name: "different-name",
            exports: Effect.succeed({ Counter: nativeExport }) as unknown as WorkerProps["exports"],
          },
          oldBindings: [],
          output: { ...output, tags: [] },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("does not infer deletion from an unresolved binding", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          newBindings: [{ sid: "Counter", data: undefined }],
          news: { name: "different-name" },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("defers deletion decisions for Effect-valued binding data", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          newBindings: [
            {
              sid: "Counter",
              data: Effect.succeed({
                bindings: [
                  { type: "durable_object_namespace", name: "Counter", className: "Counter" },
                ],
              }),
            },
          ],
          news: { name: "different-name" },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("allows explicit data-preserving renamedFrom rather than deleting the class", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          newBindings: [newBinding("Meter", { renamedFrom: "Counter" })],
          news: { name: "different-name" },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("preserves an implicit class rename under the same logical binding id", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          oldBindings: [oldBinding("Counter", "Meter")],
          newBindings: [newBinding("Meter")],
          output: { ...output, tags: [] },
          news: { name: "different-name" },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("does not treat references to a class on another host as deletion", () =>
      Effect.gen(function* () {
        const result = yield* planDiff({
          protected: true,
          newBindings: [newBinding("Counter", { scriptName: "other-worker" })],
          news: { name: "different-name" },
        });
        expect(result?.action).toBe("replace");
      }),
    );

    it.effect("rejects deletion after an unrelated property change", () =>
      Effect.gen(function* () {
        const error = yield* planDiff({
          protected: true,
          news: { crons: ["0 0 * * *"] },
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ classNames: ["Counter"] });
      }),
    );

    it.effect("uses the provider's typed error, not an unhandled defect", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(planDiff({ protected: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = yield* planDiff({ protected: true }).pipe(Effect.flip);
          expect(error._tag).toBe("ProtectedDurableObjectClassDeletion");
        }
      }),
    );

    it.effect("rejects actual reconciled deleted_classes before any API writes", () =>
      Effect.gen(function* () {
        const fixture = reconcileWithApi();
        const error = yield* fixture.result.pipe(Effect.flip);
        expect(error._tag).toBe("ProtectedDurableObjectClassDeletion");
        expect(error).toMatchObject({ classNames: ["Counter"] });
        expect(fixture.calls.some((call) => !call.startsWith("GET "))).toBe(false);
      }),
    );
  },
);
