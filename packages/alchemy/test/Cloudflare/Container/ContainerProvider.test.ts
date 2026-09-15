import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { LiveContainerProvider } from "@/Cloudflare/Containers/ContainerProvider";
import { isResolved } from "@/Diff";
import { CycleContainer, CycleWorker } from "./fixtures/provider-cycle.ts";
import type { AsyncEchoObject } from "./fixtures/async/worker.ts";
import type { ContainerApplication } from "@/Cloudflare/Containers/ContainerApplication";
import { DockerLive } from "@/Docker/Docker";
import * as Provider from "@/Provider";
import { noopSession } from "@/Report";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { expect } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const accountId = "11111111111111111111111111111111";
const digest = `sha256:${"a".repeat(64)}`;
const image = `registry.cloudflare.com/${accountId}/fixture@${digest}`;
const attachment = { namespaceId: "namespace", className: "HostedContainer" };
const bindings = [{ sid: "host", data: { durableObjects: attachment } }];
const session = { ...noopSession, note: () => Effect.void };

type WireApplication = {
  id: string;
  name: string;
  account_id: string;
  scheduling_policy: string;
  instances: number;
  max_instances: number;
  configuration: Record<string, unknown>;
  durable_objects?: { namespace_id: string; class_name?: string };
  constraints?: unknown;
  affinities?: unknown;
  created_at: string;
  version: number;
};

type Call = { method: string; url: string; body: Record<string, any> };
class MockApi extends Context.Service<
  MockApi,
  {
    apps: Map<string, WireApplication>;
    workers: Map<string, Cloudflare.Worker["Attributes"]>;
    events: string[];
    calls: Call[];
    createRace: boolean;
    updateRace: boolean;
    legacy: boolean;
    nextId: number;
  }
>()("ContainerProviderTest/MockApi") {}

const mock = Layer.effect(
  MockApi,
  Effect.sync(() => ({
    apps: new Map<string, WireApplication>(),
    workers: new Map<string, Cloudflare.Worker["Attributes"]>(),
    events: [],
    calls: [],
    createRace: false,
    updateRace: false,
    legacy: false,
    nextId: 0,
  })),
);
const services = Layer.mergeAll(
  DockerLive,
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("offline"),
      accountId,
      source: { type: "env" },
    }),
  ),
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: "offline" })),
  ),
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const api = yield* MockApi;
      return HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(
                  new TextDecoder().decode(request.body.body),
                ) as Record<string, any>)
              : {};
          const path = new URL(request.url).pathname;
          const segments = path.split("/");
          const rollout = segments.at(-1) === "rollouts";
          const id = rollout ? segments.at(-2)! : segments.at(-1)!;
          api.calls.push({ method: request.method, url: path, body });
          const respond = (result: unknown, status = 200) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ success: true, result }), {
                status,
                headers: { "content-type": "application/json" },
              }),
            );
          const missing = () =>
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  success: false,
                  errors: [{ code: 1609, message: "APPLICATION_NOT_FOUND" }],
                }),
                {
                  status: 404,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
          if (request.method === "GET") {
            return id === "applications"
              ? respond([...api.apps.values()])
              : api.apps.has(id)
                ? respond(api.apps.get(id))
                : missing();
          }
          if (request.method === "DELETE") {
            return api.apps.delete(id) ? respond({}) : missing();
          }
          if (request.method === "POST" && !rollout) {
            if (api.legacy && body.image) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    success: false,
                    errors: [
                      {
                        message: JSON.stringify({
                          error: "VALIDATE_INPUT",
                          details: {
                            durable_objects: 'unrecognized key: "class_name"',
                            ".": 'unrecognized keys: "image", "instance_type", "environment_variables"',
                          },
                        }),
                      },
                    ],
                  }),
                  {
                    status: 400,
                    headers: { "content-type": "application/json" },
                  },
                ),
              );
            }
            const app: WireApplication = {
              id: `application-${++api.nextId}`,
              name: body.name,
              account_id: accountId,
              scheduling_policy: body.scheduling_policy,
              instances: body.instances,
              max_instances: body.max_instances,
              configuration: body.configuration ?? {
                image: body.image,
                instance_type: body.instance_type,
                environment_variables: body.environment_variables,
              },
              durable_objects: body.durable_objects,
              constraints: body.constraints,
              affinities: body.affinities,
              created_at: "2026-09-15T00:00:00Z",
              version: 1,
            };
            api.apps.set(app.id, app);
            api.events.push(`create:${body.durable_objects.class_name}`);
            if (api.createRace) {
              api.createRace = false;
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    success: false,
                    errors: [
                      {
                        code: 1608,
                        message: "DURABLE_OBJECT_ALREADY_HAS_APPLICATION",
                      },
                    ],
                  }),
                  {
                    status: 409,
                    headers: { "content-type": "application/json" },
                  },
                ),
              );
            }
            return respond(app);
          }
          if (request.method === "PATCH" && api.updateRace) {
            api.updateRace = false;
            api.apps.delete(id);
            return missing();
          }
          const app = api.apps.get(id);
          if (!app) return missing();
          if (rollout) {
            app.configuration = body.target_configuration;
            app.version++;
          } else {
            Object.assign(app, body);
          }
          return respond(app);
        }),
      );
    }),
  ),
).pipe(Layer.provideMerge(mock));

const workerProvider = Provider.effect(
  Cloudflare.Worker,
  Effect.gen(function* () {
    const api = yield* MockApi;
    return Cloudflare.Worker.Provider.of({
      read: ({ id }) => Effect.sync(() => api.workers.get(id)),
      precreate: ({ id, bindings }) =>
        Effect.sync(() => {
          const containers = bindings.flatMap(
            (binding) => binding.data.containers ?? [],
          );
          expect(containers.length).toBe(1);
          expect(typeof containers[0].className).toBe("string");
          expect(isResolved(containers[0].dev)).toBe(false);
          const className = containers[0].className;
          const attrs: Cloudflare.Worker["Attributes"] = {
            workerId: id,
            workerName: id,
            accountId,
            namespace: undefined,
            logpush: undefined,
            url: undefined,
            urls: [],
            domain: undefined,
            tags: [],
            durableObjectNamespaces: { [className]: `namespace-${className}` },
            routes: [],
            crons: [],
          };
          api.workers.set(id, attrs);
          api.events.push(`precreate:${className}`);
          return attrs;
        }),
      reconcile: ({ id, bindings }) =>
        Effect.sync(() => {
          expect(isResolved(bindings)).toBe(true);
          api.events.push(`reconcile:${id}`);
          return api.workers.get(id)!;
        }),
      delete: ({ output }) =>
        Effect.sync(() => {
          api.workers.delete(output.workerName);
        }),
      list: () => Effect.sync(() => [...api.workers.values()]),
    });
  }),
);

const { test } = Test.make({
  providers: Layer.mergeAll(LiveContainerProvider(), workerProvider).pipe(
    Layer.provideMerge(services),
  ),
});

const props: ContainerApplication["Props"] = {
  image,
  name: "container-provider-regression",
  maxInstances: 3,
  env: { PLAIN: "desired" },
  observability: { logs: { enabled: true } },
  secrets: [{ name: "TOKEN", type: "env", secret: "stored-token" }],
  network: { assign_ipv4: "predefined", mode: "public" },
  dns: { servers: ["1.1.1.1"] },
  labels: [{ name: "team", value: "alchemy" }],
  ports: [{ name: "http", port: 8080 }],
  checks: [{ name: "ready", type: "http", port: "8080" }],
  command: ["serve"],
  entrypoint: ["app"],
  sshPublicKeyIds: ["key"],
};
const program = (news = props) =>
  Effect.gen(function* () {
    const app = yield* Cloudflare.Container("Application", news).Application;
    yield* app.bind`host`({ durableObjects: attachment });
    return { app };
  });
const input = (output: ContainerApplication["Attributes"], news = props) => ({
  id: "Application",
  fqn: "Application",
  instanceId: "offline",
  news,
  olds: props,
  output,
  session,
  bindings,
});
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

test.provider(
  "flat create synchronizes every advanced setting through nested PATCH and rollout",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      expect(provider.precreate).toBeUndefined();
      const { app } = yield* stack.deploy(program());
      const create = api.calls.find((call) => call.method === "POST")!;
      expect(create.body.configuration).toBeUndefined();
      expect(create.body).toMatchObject({
        image,
        max_instances: 3,
        scheduling_policy: "durable_object",
        durable_objects: {
          namespace_id: "namespace",
          class_name: "HostedContainer",
        },
      });
      const patch = api.calls.find((call) => call.method === "PATCH")!;
      expect(patch.body.configuration).toMatchObject({
        secrets: props.secrets,
        network: props.network,
        dns: props.dns,
        observability: props.observability,
        labels: props.labels,
        ports: props.ports,
        checks: props.checks,
        command: props.command,
        entrypoint: props.entrypoint,
        ssh_public_key_ids: props.sshPublicKeyIds,
      });
      expect(api.calls.some((call) => call.url.endsWith("/rollouts"))).toBe(
        true,
      );
      const observed = yield* Containers.getContainerApplication({
        accountId,
        applicationId: app.applicationId,
      });
      expect(observed.configuration.secrets).toEqual(props.secrets);
      const count = writes(api.calls).length;
      yield* provider.reconcile(input(app));
      expect(writes(api.calls).length).toBe(count);
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "matching stored hashes do not conceal observed image, settings, or scaling drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const { app } = yield* stack.deploy(program());
      const cloud = api.apps.get(app.applicationId)!;
      cloud.configuration.image = `registry.cloudflare.com/${accountId}/other@sha256:${"b".repeat(64)}`;
      cloud.configuration.network = { mode: "private" };
      cloud.configuration.environment_variables = [
        { name: "PLAIN", value: "drift" },
      ];
      cloud.max_instances = 99;
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const drifted = yield* provider.read!({
        id: "Application",
        fqn: "Application",
        instanceId: "offline",
        olds: props,
        output: app,
      });
      expect(
        yield* provider.diff!({
          id: "Application",
          fqn: "Application",
          instanceId: "offline",
          olds: props,
          news: props,
          output: drifted,
          oldBindings: bindings,
          newBindings: bindings,
        }),
      ).toMatchObject({ action: "update" });
      const updated = yield* provider.reconcile(input(app));
      expect(updated.hash?.configuration).toBe(app.hash?.configuration);
      expect(updated.configuration.image).toBe(image);
      expect(updated.configuration.network).toEqual(props.network);
      expect(updated.maxInstances).toBe(3);
      expect(api.nextId).toBe(1);
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "adoption without olds and namespace-only legacy state preserve a healthy application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const { app } = yield* stack.deploy(program());
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const adopted = yield* provider.reconcile({
        ...input(app),
        olds: undefined,
        output: {
          ...app,
          hash: undefined,
          durableObjects: { namespaceId: attachment.namespaceId },
        },
      });
      expect(adopted.applicationId).toBe(app.applicationId);
      expect(adopted.durableObjects).toEqual(attachment);
      expect(api.nextId).toBe(1);
      const diff = yield* provider.diff!({
        id: "Application",
        fqn: "Application",
        instanceId: "offline",
        olds: props,
        news: props,
        output: adopted,
        oldBindings: [
          {
            sid: "host",
            data: { durableObjects: { namespaceId: attachment.namespaceId } },
          },
        ] as typeof bindings,
        newBindings: bindings,
      });
      expect(diff?.action).not.toBe("replace");
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "create conflicts converge and a delete racing PATCH recreates with advanced settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      api.createRace = true;
      const { app } = yield* stack.deploy(program());
      expect(api.nextId).toBe(1);
      api.updateRace = true;
      api.apps.get(app.applicationId)!.configuration.dns = {};
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const recreated = yield* provider.reconcile(input(app));
      expect(recreated.applicationId).not.toBe(app.applicationId);
      expect(recreated.configuration.secrets).toEqual(props.secrets);
      expect(recreated.configuration.dns).toEqual(props.dns);
      expect(recreated.durableObjects).toEqual(attachment);
      yield* provider.delete({ ...input(recreated), olds: props });
      yield* provider.delete({ ...input(recreated), olds: props });
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "legacy detached cloud state is replaced only to attach a real namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const { app } = yield* stack.deploy(program());
      delete api.apps.get(app.applicationId)!.durable_objects;
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const recreated = yield* provider.reconcile(input(app));
      expect(recreated.applicationId).not.toBe(app.applicationId);
      expect(recreated.hash?.digest).toBe(app.hash?.digest);
      expect(recreated.configuration.secrets).toEqual(props.secrets);
      yield* provider.delete({ ...input(recreated), olds: props });
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "standalone applications and conflicting classes fail before image or API work",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const reconcile = (bindingData: typeof bindings) =>
        provider
          .reconcile({
            id: "Application",
            fqn: "Application",
            instanceId: "offline",
            news: props,
            olds: undefined,
            output: undefined,
            session,
            bindings: bindingData,
          })
          .pipe(Effect.result);
      const missing = yield* reconcile([]);
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing))
        expect(missing.failure.message).toContain(
          "requires a Durable Object namespace and class name",
        );
      const conflict = yield* reconcile([
        ...bindings,
        {
          sid: "other",
          data: { durableObjects: { ...attachment, className: "Other" } },
        },
      ]);
      expect(Result.isFailure(conflict)).toBe(true);
      expect(api.calls.length).toBe(0);
      yield* stack.destroy();
    }),
);

for (const mode of [
  "effect-native",
  "async-explicit",
  "async-inferred",
] as const) {
  test.provider(
    `${mode} worker cycle resolves through Worker precreate without a Container stub`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const api = yield* MockApi;
        const className =
          mode === "effect-native"
            ? "ActualHostedClass"
            : mode === "async-explicit"
              ? "AsyncEchoObject"
              : "ECHO";
        const result = yield* stack.deploy(
          Effect.gen(function* () {
            if (mode === "effect-native") {
              yield* CycleWorker;
              return { app: yield* CycleContainer.Application };
            }
            const container = Cloudflare.Container<AsyncEchoObject>(
              "CycleAsyncContainer",
              {
                image,
                ...(mode === "async-explicit" ? { className } : {}),
              },
            );
            const main = yield* Effect.sync(
              () =>
                new URL("./fixtures/async/worker.ts", import.meta.url).pathname,
            );
            yield* Cloudflare.Worker("CycleAsyncWorker", {
              main,
              env: { ECHO: container },
            });
            return { app: yield* container.Application };
          }),
        );
        expect(result.app.durableObjects).toEqual({
          namespaceId: `namespace-${className}`,
          className,
        });
        expect(api.events[0]).toBe(`precreate:${className}`);
        expect(api.events[1]).toBe(`create:${className}`);
        expect(api.events[2]).toMatch(/^reconcile:/);
        const live = yield* Containers.getContainerApplication({
          accountId,
          applicationId: result.app.applicationId,
        });
        expect(live.durableObjects?.className).toBe(className);
        yield* stack.destroy();
        expect(api.apps.size).toBe(0);
        expect(api.workers.size).toBe(0);
      }),
    { timeout: 30_000 },
  );
}

test.provider(
  "custom sizing and removed settings converge without a rebuild",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const custom = {
        ...props,
        vcpu: 2,
        memory: "4GB",
        disk: { size: "10GB" },
      };
      const { app } = yield* stack.deploy(program(custom));
      const created = api.calls.find((call) => call.method === "POST")!;
      expect(created.body.instance_type).toBeUndefined();
      const patch = api.calls.find((call) => call.method === "PATCH")!;
      expect(patch.body.configuration).toMatchObject({
        vcpu: 2,
        memory: "4GB",
        disk: { size: "10GB" },
        instance_type: null,
      });
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const updated = yield* provider.reconcile({
        ...input(app, { image, name: props.name }),
        olds: custom,
      });
      expect(updated.configuration.secrets).toBeUndefined();
      expect(updated.configuration.network).toBeUndefined();
      expect(updated.configuration.vcpu).toBeUndefined();
      expect(updated.configuration.instanceType).toBe("lite");
      expect(updated.hash?.image).toBe(app.hash?.image);
      expect(api.nextId).toBe(1);
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "removing placement constraints sends an empty replacement object",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const original = { ...props, constraints: { tier: 1 } };
      const { app } = yield* stack.deploy(program(original));
      const before = api.calls.length;
      const { app: updated } = yield* stack.deploy(program(props));
      const changes = writes(api.calls.slice(before));
      expect(changes.length).toBe(1);
      expect(changes[0].method).toBe("PATCH");
      expect(changes[0].body.constraints).toEqual({});
      expect(updated.applicationId).toBe(app.applicationId);
      const observed = yield* Containers.getContainerApplication({
        accountId,
        applicationId: app.applicationId,
      });
      expect(observed.constraints).toEqual({});

      // A default returned after the reset is not a newly managed constraint.
      api.apps.get(app.applicationId)!.constraints = { tier: 0 };
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const count = writes(api.calls).length;
      yield* provider.reconcile(input(updated));
      expect(writes(api.calls).length).toBe(count);
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "removing nested network fields replaces the object without null members",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const { app } = yield* stack.deploy(program());
      const reduced = { ...props, network: { mode: "public" } };
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      expect(
        yield* provider.diff!({
          id: "Application",
          fqn: "Application",
          instanceId: "offline",
          olds: props,
          news: reduced,
          output: app,
          oldBindings: bindings,
          newBindings: bindings,
        }),
      ).toMatchObject({ action: "update" });
      const before = api.calls.length;
      const { app: updated } = yield* stack.deploy(program(reduced));
      const changes = writes(api.calls.slice(before));
      expect(changes.length).toBe(2);
      expect(changes[0].method).toBe("PATCH");
      expect(changes[0].body.configuration.network).toEqual({ mode: "public" });
      expect(changes[1].url.endsWith("/rollouts")).toBe(true);
      expect(changes[1].body.target_configuration.network).toEqual({
        mode: "public",
      });
      const observed = yield* Containers.getContainerApplication({
        accountId,
        applicationId: app.applicationId,
      });
      expect(observed.configuration.network).toEqual({ mode: "public" });
      expect(updated.applicationId).toBe(app.applicationId);

      api.apps.get(app.applicationId)!.configuration.network = {
        mode: "public",
        assign_ipv4: "default",
      };
      const count = writes(api.calls).length;
      yield* provider.reconcile({ ...input(updated, reduced), olds: reduced });
      expect(writes(api.calls).length).toBe(count);
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "removed fields already absent in observed state do not trigger writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      const original = { ...props, constraints: { tier: 1 } };
      const { app } = yield* stack.deploy(program(original));
      const reduced = { ...props, network: { mode: "public" } };
      const cloud = api.apps.get(app.applicationId)!;
      cloud.constraints = { server_default: true };
      cloud.configuration.network = { mode: "public", server_default: true };
      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const count = writes(api.calls).length;
      const updated = yield* provider.reconcile({
        ...input(app, reduced),
        olds: original,
      });
      expect(writes(api.calls).length).toBe(count);
      expect(updated.configuration.network).toEqual({
        mode: "public",
        server_default: true,
      });
      expect(updated.constraints).toEqual({ server_default: true });
      yield* stack.destroy();
      expect(api.apps.size).toBe(0);
    }),
);

test.provider(
  "the captured unsupported-create response is typed and never retried as a conflict",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* MockApi;
      api.legacy = true;
      const result = yield* Containers.createContainerApplication({
        accountId,
        name: "shape-probe",
        image,
        maxInstances: 1,
        schedulingPolicy: "durable_object",
        durableObjects: attachment,
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure._tag).toBe("ContainerCreateShapeUnsupported");
      expect(api.calls.length).toBe(1);
      expect(api.apps.size).toBe(0);
      yield* stack.destroy();
    }),
);
