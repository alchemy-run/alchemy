import {
  isManagedServiceAccount,
  releaseHostIdentity,
  resolveHostIdentity,
} from "@alchemy.run/gcp/HostRuntime";
import {
  nodeTemplate,
  secretGrants,
  type CloudRunPoolOptions,
} from "@alchemy.run/rivet/GCP/CloudRunPool";
import { describe, expect, test } from "@alchemy.run/test";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const project = "acme";
const hostType = "GCP.Run.WorkerPool";
const resourceName = "projects/acme/locations/us-central1/workerPools/default-nodes";
const secret = "projects/acme/secrets/rivet-token";
const accessor = "roles/secretmanager.secretAccessor";

type Policy = { bindings?: Array<{ role: string; members: string[] }>; etag?: string };

/** Service accounts and IAM policies of one project, served over the GCP REST paths. */
const fakeProject = (existing: readonly string[] = []) => {
  const accounts = new Set(existing);
  const policies = new Map<string, Policy>();
  const log: string[] = [];
  const respond = (request: HttpClientRequest.HttpClientRequest, status: number, body: unknown) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  const client = HttpClient.make((request, url) => {
    const path = decodeURIComponent(url.pathname).replace(/^\/v\d+\//, "");
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    const [resource, verb] = path.split(":");
    if (verb === "getIamPolicy") {
      return respond(request, 200, policies.get(resource!) ?? { etag: "e0", bindings: [] });
    }
    if (verb === "setIamPolicy") {
      policies.set(resource!, { ...body.policy, etag: `e${log.length + 1}` });
      log.push(`setIamPolicy ${resource}`);
      return respond(request, 200, policies.get(resource!));
    }
    if (url.hostname.startsWith("cloudresourcemanager.")) {
      return respond(request, 200, { name: "projects/123456", projectId: project });
    }
    const email = path.match(/^projects\/[^/]+\/serviceAccounts\/(.+)$/)?.[1];
    if (email !== undefined && request.method === "GET") {
      return accounts.has(email)
        ? respond(request, 200, { email, uniqueId: "1001" })
        : respond(request, 404, {
            error: { code: 404, message: "Not found", status: "NOT_FOUND" },
          });
    }
    if (email !== undefined && request.method === "DELETE") {
      accounts.delete(email);
      log.push(`delete ${email}`);
      return respond(request, 200, {});
    }
    if (request.method === "POST" && /^projects\/[^/]+\/serviceAccounts$/.test(path)) {
      const created = `${body.accountId}@${project}.iam.gserviceaccount.com`;
      accounts.add(created);
      log.push(`create ${created}`);
      return respond(request, 200, { email: created, uniqueId: "1001" });
    }
    return Effect.die(`unexpected ${request.method} ${url.href}`);
  });
  const members = (resource: string, role: string) =>
    policies.get(resource)?.bindings?.find((binding) => binding.role === role)?.members ?? [];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Credentials, Effect.succeed({ accessToken: Redacted.make("token"), project })),
  );
  return { accounts, log, members, layer };
};

/** The identity a worker pool resolves for a pool's options, as `Run.WorkerPool` reconciles it. */
const deploy = (
  options: CloudRunPoolOptions,
  output: Parameters<typeof resolveHostIdentity>[0]["output"],
) =>
  Effect.gen(function* () {
    const template = nodeTemplate(options, { serviceAccount: options.serviceAccount });
    const versions = Object.values(options.secrets ?? {}) as string[];
    const identity = yield* resolveHostIdentity({
      project,
      hostType,
      resourceName,
      userServiceAccount: template.serviceAccount as string | undefined,
      effectNative: true,
      bindings:
        options.serviceAccount === undefined && versions.length > 0
          ? [
              {
                sid: "RivetGCP.CloudRunPool.secrets(Default)",
                data: { iam: secretGrants(versions) },
              },
            ]
          : [],
      output,
    });
    return {
      serviceAccount: identity.serviceAccount,
      serviceAccountUniqueId: identity.uniqueId,
      managedServiceAccount: isManagedServiceAccount({
        project,
        hostType,
        resourceName,
        serviceAccount: identity.serviceAccount,
      }),
      iamGrants: identity.grants,
    };
  });

const secrets = { RIVET_TOKEN: `${secret}/versions/2` };

describe("RivetGCP.CloudRunPool node identity", { tags: ["unit", "provider:gcp", "local"] }, () => {
  test("a pool keeps one account of its own from plain to secrets to destroy", () => {
    const gcp = fakeProject();
    return Effect.gen(function* () {
      const plain = yield* deploy({}, undefined);
      expect(plain.managedServiceAccount).toBe(true);
      expect([...gcp.accounts]).toEqual([plain.serviceAccount]);

      const withSecrets = yield* deploy({ secrets }, plain);
      // The same account, granted the secret before the worker pool rolls
      // out a revision that reads it.
      expect(withSecrets.serviceAccount).toBe(plain.serviceAccount);
      expect(gcp.members(secret, accessor)).toEqual([`serviceAccount:${plain.serviceAccount}`]);
      expect(gcp.log.filter((line) => line.startsWith("create"))).toHaveLength(1);

      yield* releaseHostIdentity({ project, ...withSecrets });
      expect(gcp.accounts.size).toBe(0);
      expect(gcp.members(secret, accessor)).toEqual([]);
    }).pipe(Effect.provide(gcp.layer), Effect.runPromise);
  });

  test("dropping secrets revokes the grant and keeps the pool's account", () => {
    const gcp = fakeProject();
    return Effect.gen(function* () {
      const withSecrets = yield* deploy({ secrets }, undefined);
      const plain = yield* deploy({}, withSecrets);
      expect(plain.serviceAccount).toBe(withSecrets.serviceAccount);
      expect(gcp.members(secret, accessor)).toEqual([]);
      expect([...gcp.accounts]).toEqual([plain.serviceAccount]);
    }).pipe(Effect.provide(gcp.layer), Effect.runPromise);
  });

  test("an account of the user's own runs the nodes and is never deleted", () => {
    const own = "nodes@acme.iam.gserviceaccount.com";
    const gcp = fakeProject([own]);
    return Effect.gen(function* () {
      const deployed = yield* deploy({ serviceAccount: own, secrets }, undefined);
      expect(deployed.serviceAccount).toBe(own);
      expect(deployed.managedServiceAccount).toBe(false);

      yield* releaseHostIdentity({ project, ...deployed });
      expect([...gcp.accounts]).toEqual([own]);
      expect(gcp.log.filter((line) => /^(create|delete) /.test(line))).toEqual([]);
    }).pipe(Effect.provide(gcp.layer), Effect.runPromise);
  });
});
