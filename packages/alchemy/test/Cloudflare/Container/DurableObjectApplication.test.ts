import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Cloudflare from "@/Cloudflare";
import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthConfig.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { ContainerProvider } from "@/Cloudflare/Containers/ContainerApplication.ts";
import { ContainerPlatform } from "@/Cloudflare/Containers/ContainerPlatform.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import { WorkerProvider } from "@/Cloudflare/Workers/WorkerProvider.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";

/**
 * A `durable_object` container application without an image of its own,
 * bound on an async Worker's `env`, deployed through the engine against an
 * in-memory Cloudflare API.
 *
 * The fake enforces the documented contract of the `durable_object` branch of
 * `POST /containers/applications` (`additionalProperties: false`): only
 * `name`, `scheduling_policy`, `durable_objects`, `configuration`
 * (`authorized_keys`, `wrangler_ssh`) and `observability`. `PATCH` accepts
 * only `observability` and that `configuration`. The application id is the
 * Durable Object namespace id, and there are no rollouts.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const IMAGE = `registry.cloudflare.com/${ACCOUNT_ID}/sandbox@sha256:${"a".repeat(64)}`;

const script = `
import { DurableObject } from "cloudflare:workers";
export class Box extends DurableObject {
  async fetch() { return new Response("box"); }
}
export default { fetch() { return new Response("ok"); } };
`;

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly body: any;
}

const envelope = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status,
    headers: { "content-type": "application/json" },
  });

const failure = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
    { status, headers: { "content-type": "application/json" } },
  );

const DURABLE_OBJECT_CREATE_KEYS = [
  "name",
  "scheduling_policy",
  "durable_objects",
  "configuration",
  "observability",
];
const DURABLE_OBJECT_PATCH_KEYS = ["configuration", "observability"];

const makeFakeCloudflareApi = () => {
  const captured: Captured[] = [];
  const scripts = new Map<string, { metadata: any; subdomain?: boolean }>();
  const namespaces: Array<{
    id: string;
    name: string;
    script: string;
    class: string;
    use_sqlite: boolean;
    use_containers: boolean;
  }> = [];
  const applications = new Map<string, any>();
  let nextId = 1;
  const newId = () => (nextId++).toString(16).padStart(32, "0");

  const handle = (method: string, path: string, body: any): Response => {
    const prefix = `/client/v4/accounts/${ACCOUNT_ID}`;
    if (!path.startsWith(prefix)) {
      return failure(404, 7003, `Could not route to ${path}`);
    }
    const route = path.slice(prefix.length);
    const segments = route.split("/").filter(Boolean);

    // Containers
    if (route === "/containers/image-preparations" && method === "POST") {
      return envelope({
        image: body.image,
        status: "ready",
        artifact_digest: `sha256:${"b".repeat(64)}`,
      });
    }
    if (route === "/containers/applications" && method === "GET") {
      return envelope([...applications.values()]);
    }
    if (route === "/containers/applications" && method === "POST") {
      if (body.scheduling_policy === "durable_object") {
        const extra = Object.keys(body).filter((key) => !DURABLE_OBJECT_CREATE_KEYS.includes(key));
        if (extra.length > 0 || body.configuration?.image !== undefined) {
          return failure(400, 1000, `additional properties are not allowed: ${extra.join(", ")}`);
        }
        const namespaceId = body.durable_objects?.namespace_id;
        const namespace = namespaces.find((ns) => ns.id === namespaceId);
        if (!namespace?.use_containers) {
          return failure(400, 1607, "DURABLE_OBJECT_NOT_CONTAINER_ENABLED");
        }
        if (applications.has(namespaceId)) {
          return failure(409, 1608, "DURABLE_OBJECT_ALREADY_HAS_APPLICATION");
        }
        const application = {
          id: namespaceId,
          name: body.name,
          account_id: ACCOUNT_ID,
          scheduling_policy: "durable_object",
          durable_objects: { namespace_id: namespaceId },
          configuration: {},
          ...(body.observability ? { observability: body.observability } : {}),
          created_at: "2026-10-07T00:00:00Z",
        };
        applications.set(namespaceId, application);
        return envelope(application);
      }
      // A fleet application. A `durable_object` application never takes this path.
      const id = newId();
      const application = {
        id,
        name: body.name,
        account_id: ACCOUNT_ID,
        scheduling_policy: body.scheduling_policy ?? "default",
        instances: body.instances ?? 0,
        max_instances: body.max_instances,
        configuration: body.configuration,
        durable_objects: body.durable_objects,
        created_at: "2026-10-07T00:00:00Z",
        version: 1,
      };
      applications.set(id, application);
      return envelope(application);
    }
    if (segments[0] === "containers" && segments[1] === "applications" && segments[2]) {
      const application = applications.get(segments[2]);
      if (!application || segments.length > 3) {
        return failure(404, 1609, "Container application not found");
      }
      if (method === "GET") return envelope(application);
      if (method === "DELETE") {
        applications.delete(segments[2]);
        return envelope(null);
      }
      if (method === "PATCH") {
        if (application.scheduling_policy === "durable_object") {
          const extra = Object.keys(body).filter((key) => !DURABLE_OBJECT_PATCH_KEYS.includes(key));
          if (extra.length > 0) {
            return failure(400, 1000, `additional properties are not allowed: ${extra.join(", ")}`);
          }
        }
        Object.assign(application, body);
        return envelope(application);
      }
    }

    // Durable Object namespaces
    if (route.startsWith("/workers/durable_objects/namespaces") && method === "GET") {
      return envelope(namespaces);
    }

    // Workers
    if (route === "/workers/subdomain" && method === "GET") {
      return envelope({ subdomain: "fake" });
    }
    if (route === "/workers/domains" && method === "GET") {
      return envelope([]);
    }
    if (route === "/workers/scripts" && method === "GET") {
      return envelope([...scripts.keys()].map((id) => ({ id, tag: `tag-${id}` })));
    }
    if (segments[0] === "workers" && segments[1] === "scripts" && segments[2]) {
      const name = segments[2];
      const sub = segments.slice(3).join("/");
      if (sub === "" && method === "PUT") {
        const metadata = body.metadata;
        for (const className of metadata.migrations?.new_sqlite_classes ?? []) {
          if (!namespaces.some((ns) => ns.script === name && ns.class === className)) {
            namespaces.push({
              id: newId(),
              name: `${name}_${className}`,
              script: name,
              class: className,
              use_sqlite: true,
              use_containers: false,
            });
          }
        }
        for (const container of metadata.containers ?? []) {
          for (const ns of namespaces) {
            if (ns.script === name && ns.class === container.class_name) ns.use_containers = true;
          }
        }
        scripts.set(name, { ...scripts.get(name), metadata });
        return envelope({ id: name, tag: `tag-${name}`, etag: "etag", logpush: false });
      }
      const existing = scripts.get(name);
      if (!existing) return failure(404, 10007, "This Worker does not exist on your account.");
      if (sub === "" && method === "DELETE") {
        scripts.delete(name);
        for (let i = namespaces.length - 1; i >= 0; i--) {
          if (namespaces[i]!.script === name) {
            applications.delete(namespaces[i]!.id);
            namespaces.splice(i, 1);
          }
        }
        return envelope(null);
      }
      if (sub === "settings" && method === "GET") {
        const { metadata } = existing;
        return envelope({
          // Cloudflare reports each local Durable Object binding with its namespace id.
          bindings: (metadata.bindings ?? []).map((binding: any) =>
            binding.type === "durable_object_namespace" && !binding.script_name
              ? {
                  ...binding,
                  namespace_id: namespaces.find(
                    (ns) => ns.script === name && ns.class === binding.class_name,
                  )?.id,
                }
              : binding,
          ),
          compatibility_date: metadata.compatibility_date,
          compatibility_flags: metadata.compatibility_flags ?? [],
          logpush: false,
          tags: metadata.tags ?? [],
          tail_consumers: [],
        });
      }
      if (sub === "subdomain" && method === "GET") {
        return envelope({ enabled: existing.subdomain ?? false, previews_enabled: false });
      }
      if (sub === "subdomain" && method === "POST") {
        existing.subdomain = body.enabled;
        return envelope({ enabled: body.enabled, previews_enabled: body.previews_enabled });
      }
      if (sub === "schedules" && method === "GET") {
        return envelope({ schedules: [] });
      }
      if (sub === "deployments" && method === "GET") {
        return envelope({ deployments: [] });
      }
    }

    return failure(404, 7003, `Could not route to ${method} ${route} (fake Cloudflare API)`);
  };

  const client = HttpClient.make((request) =>
    Effect.promise(async () => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      let parsed: any;
      if (body._tag === "Uint8Array") {
        const text = new TextDecoder().decode(body.body);
        parsed = text ? JSON.parse(text) : undefined;
      } else if (body._tag === "FormData") {
        const metadata = body.formData.get("metadata");
        parsed = {
          metadata: JSON.parse(typeof metadata === "string" ? metadata : await metadata!.text()),
        };
      }
      captured.push({ method: request.method, path: url.pathname, body: parsed });
      return HttpClientResponse.fromWeb(request, handle(request.method, url.pathname, parsed));
    }),
  );

  const credentials: CloudflareResolvedCredentials = {
    type: "apiToken",
    apiToken: Redacted.make("test-token"),
    accountId: ACCOUNT_ID,
    source: { type: "env" },
  };

  return {
    captured,
    applications,
    namespaces,
    scripts,
    /** The application creates, updates and deletes, in order. */
    applicationWrites: () =>
      captured.filter(
        (request) => request.path.includes("/containers/applications") && request.method !== "GET",
      ),
    /** The Worker script uploads, in order. */
    scriptUploads: () =>
      captured.filter(
        (request) => request.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(request.path),
      ),
    layer: Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make("test-token") })),
      ),
      Layer.succeed(CloudflareEnvironment, Effect.succeed(credentials)),
    ),
  };
};

class FakeCloudflareProviders extends Provider.ProviderCollection<FakeCloudflareProviders>()(
  "Cloudflare",
) {}

/** A test API whose Worker and Container providers talk to their own fake. */
const makeTest = () => {
  const api = makeFakeCloudflareApi();
  const { test } = Test.make({
    providers: Layer.effect(
      FakeCloudflareProviders,
      Provider.collection([Worker, ContainerPlatform]),
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(WorkerProvider(), ContainerProvider())),
      Layer.provide(DockerLive),
      Layer.provideMerge(api.layer),
      Layer.orDie,
    ),
  });
  return { api, test };
};

const tags = ["unit", "provider:cloudflare", "provider:cloudflare:container", "local"];

const program = ({
  attached = true,
  observability,
}: { attached?: boolean; observability?: { logs: { enabled: boolean } } } = {}) =>
  Effect.gen(function* () {
    const container = Cloudflare.Container("Box", {
      className: "Box",
      name: "box-sandbox",
      schedulingPolicy: "durable_object",
      observability,
      images: { sandbox: { image: IMAGE } },
    });
    const worker = yield* Cloudflare.Worker("BoxWorker", {
      name: "box-worker",
      script,
      env: attached ? { BOX: container } : {},
    });
    return {
      namespaces: worker.durableObjectNamespaces,
      app: attached ? yield* container.Application : undefined,
    };
  });

const lifecycle = makeTest();
lifecycle.test.provider(
  "durable_object application without an image: create, noop, observability update, delete",
  (stack) =>
    Effect.gen(function* () {
      const { api } = lifecycle;
      const { applicationWrites, scriptUploads } = api;
      yield* stack.destroy();
      api.captured.length = 0;

      const first = yield* stack.deploy(program());
      const namespaceId = first.namespaces.Box;
      expect(namespaceId).toBeDefined();

      // Precreate creates nothing: the one application write is the create,
      // with only the fields the `durable_object` branch accepts.
      expect(applicationWrites()).toEqual([
        {
          method: "POST",
          path: `/client/v4/accounts/${ACCOUNT_ID}/containers/applications`,
          body: {
            name: "box-sandbox",
            scheduling_policy: "durable_object",
            durable_objects: { namespace_id: namespaceId },
          },
        },
      ]);
      // The application id is the namespace id.
      expect(first.app?.applicationId).toBe(namespaceId);
      expect(api.applications.get(namespaceId!)).toMatchObject({
        name: "box-sandbox",
        scheduling_policy: "durable_object",
      });

      // The pinned image is prepared before the first Worker upload that
      // references it. That upload's container metadata names the application
      // and carries the image, as wrangler's does.
      const firstPreparation = api.captured.findIndex((request) =>
        request.path.endsWith("/containers/image-preparations"),
      );
      const firstUploadWithImages = api.captured.findIndex(
        (request) =>
          request.method === "PUT" &&
          /\/workers\/scripts\/[^/]+$/.test(request.path) &&
          request.body.metadata.containers?.some((entry: any) => entry.images !== undefined),
      );
      expect(firstPreparation).toBeGreaterThanOrEqual(0);
      expect(firstUploadWithImages).toBeGreaterThan(firstPreparation);
      expect(api.captured[firstPreparation]!.body).toEqual({ image: IMAGE });
      expect(scriptUploads().at(-1)!.body.metadata.containers).toEqual([
        { class_name: "Box", name: "box-sandbox", images: { sandbox: IMAGE } },
      ]);

      // An unchanged deploy is a noop.
      const plan = yield* stack.plan(program());
      expect(plan.resources.Box.action).toBe("noop");
      expect(plan.resources.BoxWorker.action).toBe("noop");
      api.captured.length = 0;
      yield* stack.deploy(program());
      expect(applicationWrites()).toEqual([]);
      expect(scriptUploads()).toEqual([]);

      // An observability change patches only observability.
      const third = yield* stack.deploy(program({ observability: { logs: { enabled: true } } }));
      expect(third.app?.applicationId).toBe(namespaceId);
      expect(applicationWrites()).toEqual([
        {
          method: "PATCH",
          path: `/client/v4/accounts/${ACCOUNT_ID}/containers/applications/${namespaceId}`,
          body: { observability: { logs: { enabled: true } } },
        },
      ]);

      // Destroy deletes the application by its id.
      api.captured.length = 0;
      yield* stack.destroy();
      expect(applicationWrites()).toContainEqual({
        method: "DELETE",
        path: `/client/v4/accounts/${ACCOUNT_ID}/containers/applications/${namespaceId}`,
        body: undefined,
      });
      expect(api.applications.size).toBe(0);
    }),
  { tags },
);

const gained = makeTest();
gained.test.provider(
  "an existing Worker gains a durable_object application without an image",
  (stack) =>
    Effect.gen(function* () {
      const { api } = gained;
      yield* stack.destroy();

      const before = yield* stack.deploy(program({ attached: false }));
      expect(before.namespaces.Box).toBeUndefined();
      api.captured.length = 0;

      // The Worker is an update and the application a create. Its first
      // reconcile sees the Worker's previous namespaces, which have no id for
      // the class; the converge pass creates the application after the
      // Worker's upload creates the namespace.
      const after = yield* stack.deploy(program());
      const namespaceId = after.namespaces.Box;
      expect(namespaceId).toBeDefined();
      expect(after.app?.applicationId).toBe(namespaceId);
      expect(api.applicationWrites()).toEqual([
        {
          method: "POST",
          path: `/client/v4/accounts/${ACCOUNT_ID}/containers/applications`,
          body: {
            name: "box-sandbox",
            scheduling_policy: "durable_object",
            durable_objects: { namespace_id: namespaceId },
          },
        },
      ]);
      expect(api.scriptUploads().at(-1)!.body.metadata.containers).toEqual([
        { class_name: "Box", name: "box-sandbox", images: { sandbox: IMAGE } },
      ]);

      const plan = yield* stack.plan(program());
      expect(plan.resources.Box.action).toBe("noop");
      expect(plan.resources.BoxWorker.action).toBe("noop");

      yield* stack.destroy();
      expect(api.applications.size).toBe(0);
    }),
  { tags },
);
