import {
  ProjectIdentity,
  ProjectIdentityProvider,
  type ProjectIdentityProps,
} from "@alchemy.run/infisical/ProjectIdentity";
import { Providers } from "@alchemy.run/infisical/Providers";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/infisical/Credentials";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Stack from "alchemy/Stack";
import * as State from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

interface Role {
  role: string;
  isTemporary: boolean;
  customRoleSlug?: string;
}
interface WireOidc {
  oidcDiscoveryUrl: string;
  boundIssuer: string;
  boundAudiences: string;
  boundSubject: string;
  boundClaims: Readonly<Record<string, string>>;
  claimMetadataMapping: Readonly<Record<string, string>>;
  caCert: string;
  accessTokenTTL: number;
  accessTokenMaxTTL: number;
  accessTokenNumUsesLimit: number;
  accessTokenTrustedIps: ReadonlyArray<{ readonly ipAddress: string }>;
  templateId: string | null;
}
interface RemoteIdentity {
  id: string;
  project: string;
  name: string;
  roles: ReadonlyArray<Role>;
  oidc: WireOidc | undefined;
}
const TrustedIp = Schema.Struct({ ipAddress: Schema.String });
const issuer = "https://token.actions.githubusercontent.com";
const wireDefaults: WireOidc = {
  oidcDiscoveryUrl: issuer,
  boundIssuer: issuer,
  boundAudiences: "",
  boundSubject: "",
  boundClaims: {},
  claimMetadataMapping: {},
  caCert: "",
  accessTokenTTL: 2592000,
  accessTokenMaxTTL: 2592000,
  accessTokenNumUsesLimit: 0,
  accessTokenTrustedIps: [{ ipAddress: "0.0.0.0/0" }, { ipAddress: "::/0" }],
  templateId: null,
};

const declaration = {
  name: "pull-request",
  roles: ["reader", "deployer"] as const,
  oidcAuth: { oidcDiscoveryUrl: issuer, boundIssuer: issuer },
};

const harness = () => {
  const world = {
    identities: new Map<string, RemoteIdentity>(),
    nextId: 0,
    failAttach: false,
    failDelete: false,
    failConsumer: false,
    ignoreUpdates: false,
    installedId: "",
  };
  const findIdentity = (id: string) => world.identities.get(id);
  const requiredIdentity = (id: string) =>
    (() => {
      const identity = world.identities.get(id);
      assert(identity);
      return identity;
    })();
  const timestamp = "2026-11-05T00:00:00Z";
  const identityJson = (identity: RemoteIdentity) => ({
    id: identity.id,
    name: identity.name,
    projectId: identity.project,
    orgId: "example-org",
    createdAt: timestamp,
    updatedAt: timestamp,
    authMethods: identity.oidc ? ["oidc-auth"] : [],
  });
  const roleJson = (identity: RemoteIdentity) =>
    identity.roles.map((role, index) => ({
      ...role,
      ...(role.role === "release-manager"
        ? { role: "custom", customRoleSlug: "release-manager" }
        : {}),
      id: `${identity.id}-role-${index}`,
      projectMembershipId: `membership-${identity.id}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  const membershipJson = (identity: RemoteIdentity) => ({
    id: `membership-${identity.id}`,
    identityId: identity.id,
    projectId: identity.project,
    createdAt: timestamp,
    updatedAt: timestamp,
    identity: identityJson(identity),
    project: { id: identity.project, name: identity.project },
    roles: roleJson(identity),
  });
  const oidcJson = (identity: RemoteIdentity) => ({
    ...identity.oidc,
    accessTokenTrustedIps: identity.oidc?.accessTokenTrustedIps.map(({ ipAddress }) => {
      const [address, prefix] = ipAddress.split("/");
      return {
        ipAddress: address,
        type: ipAddress.includes(":") ? "ipv6" : "ipv4",
        ...(prefix === undefined ? {} : { prefix: Number(prefix) }),
      };
    }),
    id: `oidc-${identity.id}`,
    identityId: identity.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const Body = Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    roles: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          role: Schema.String,
          isTemporary: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    ),
    oidcDiscoveryUrl: Schema.optionalKey(Schema.String),
    boundIssuer: Schema.optionalKey(Schema.String),
    boundAudiences: Schema.optionalKey(Schema.String),
    boundSubject: Schema.optionalKey(Schema.String),
    boundClaims: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    claimMetadataMapping: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    caCert: Schema.optionalKey(Schema.String),
    accessTokenTTL: Schema.optionalKey(Schema.Number),
    accessTokenMaxTTL: Schema.optionalKey(Schema.Number),
    accessTokenNumUsesLimit: Schema.optionalKey(Schema.Number),
    accessTokenTrustedIps: Schema.optionalKey(Schema.Array(TrustedIp)),
    templateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  });

  const httpClient = HttpClient.make(
    Effect.fnUntraced(function* (request) {
      const url = Option.getOrThrow(HttpClientRequest.toUrl(request));
      const answer = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(Body))(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ).pipe(Effect.orDie);
      const missing = () => answer({ message: "Not found" }, 404);
      const membershipPath =
        /^\/api\/v1\/projects\/([^/]+)\/memberships\/identities\/([^/]+)$/.exec(url.pathname);
      if (membershipPath && request.method === "PATCH" && body.roles) {
        const [, project, id] = membershipPath;
        const identity = id ? findIdentity(id) : undefined;
        if (!identity || identity.project !== project) return missing();
        if (!world.ignoreUpdates) {
          identity.roles = body.roles.map((role) => ({
            ...role,
            isTemporary: role.isTemporary ?? false,
          }));
        }
        return answer({ identityMembership: membershipJson(identity) });
      }
      const projectPath =
        /^\/api\/v1\/projects\/([^/]+)\/(identities|identity-memberships)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (projectPath) {
        const [, project, collection, id] = projectPath;
        if (collection === "identities" && !id) {
          if (request.method === "GET") {
            const matches = [...world.identities.values()].filter(
              (identity) =>
                identity.project === project &&
                identity.name.includes(url.searchParams.get("search") ?? ""),
            );
            const offset = Number(url.searchParams.get("offset") ?? 0);
            const limit = Number(url.searchParams.get("limit") ?? 100);
            return answer({
              identities: matches.slice(offset, offset + limit).map(identityJson),
              totalCount: matches.length,
            });
          }
          if (request.method === "POST" && body.name && project) {
            const identity = {
              id: `identity-${++world.nextId}`,
              name: body.name,
              project,
              roles: (body.roles ?? []).map((role) => ({
                ...role,
                isTemporary: role.isTemporary ?? false,
              })),
              oidc: undefined,
            };
            world.identities.set(identity.id, identity);
            return answer({ identity: identityJson(identity) });
          }
        }
        const identity = id ? findIdentity(id) : undefined;
        if (!identity || identity.project !== project) return missing();
        if (collection === "identity-memberships") {
          if (request.method === "GET") {
            return answer({ identityMembership: membershipJson(identity) });
          }
        } else {
          if (request.method === "GET") return answer({ identity: identityJson(identity) });
          if (request.method === "PATCH" && body.name) {
            if (!world.ignoreUpdates) identity.name = body.name;
            return answer({ identity: identityJson(identity) });
          }
          if (request.method === "DELETE") {
            if (world.failDelete || identity.id === world.installedId) {
              return answer({ message: "Identity is still installed" }, 403);
            }
            world.identities.delete(identity.id);
            return answer({ identity: identityJson(identity) });
          }
        }
      }
      const oidcPath = /^\/api\/v1\/auth\/oidc-auth\/identities\/([^/]+)$/.exec(url.pathname);
      if (oidcPath) {
        const id = oidcPath[1];
        const identity = id ? findIdentity(id) : undefined;
        if (!identity) return missing();
        if (request.method === "GET") {
          return identity.oidc
            ? answer({ identityOidcAuth: oidcJson(identity) })
            : answer({ message: "The identity does not have OIDC Auth attached" }, 400);
        }
        if (request.method === "POST") {
          if (world.failAttach) return answer({ message: "OIDC attachment refused" }, 403);
          if (identity.oidc) return answer({ message: "OIDC already attached" }, 409);
          identity.oidc = { ...wireDefaults, ...body };
          return answer({ identityOidcAuth: oidcJson(identity) });
        }
        if (request.method === "PATCH") {
          if (!identity.oidc) return missing();
          if (!world.ignoreUpdates) identity.oidc = { ...identity.oidc, ...body };
          return answer({ identityOidcAuth: oidcJson(identity) });
        }
      }
      return yield* Effect.die(`Unexpected ${request.method} ${url.href}`);
    }),
  );

  const InstalledProps = Schema.Struct({ id: Schema.String, project: Schema.String });
  type InstalledToken = Resource<
    "Test.InfisicalInstalledToken",
    typeof InstalledProps.Type,
    typeof InstalledProps.Type
  >;
  const InstalledToken = Resource<InstalledToken>("Test.InfisicalInstalledToken");
  class InstallationRefused extends Data.TaggedError("InstallationRefused")<{
    readonly message: string;
  }> {}
  const installedProvider = Provider.succeed(InstalledToken, {
    list: () => Effect.succeed([]),
    reconcile: Effect.fnUntraced(function* ({ news }) {
      const identity = findIdentity(news.id);
      if (world.failConsumer || identity?.project !== news.project || !identity.oidc) {
        return yield* new InstallationRefused({
          message: "Identity installation refused",
        });
      }
      world.installedId = identity.id;
      return news;
    }),
    delete: () =>
      Effect.sync(() => {
        world.installedId = "";
      }),
  });
  const ProjectProps = Schema.Struct({ id: Schema.String });
  type Project = Resource<
    "Test.InfisicalProject",
    typeof ProjectProps.Type,
    typeof ProjectProps.Type
  >;
  const Project = Resource<Project>("Test.InfisicalProject");
  const projectProvider = Provider.succeed(Project, {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) => Effect.succeed(news),
    delete: () => Effect.void,
  });
  const providers = Layer.mergeAll(
    installedProvider,
    projectProvider,
    Layer.effect(Providers, Provider.collection([ProjectIdentity])).pipe(
      Layer.provideMerge(ProjectIdentityProvider()),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            Credentials,
            Effect.succeed({
              apiKey: Redacted.make("test"),
              apiBaseUrl: "https://infisical.test",
            }),
          ),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      ),
    ),
  );
  const api = Test.make({ providers });
  const resources = Effect.fnUntraced(function* (
    props: Pick<ProjectIdentityProps, "name" | "roles" | "oidcAuth"> = declaration,
    project: Input<string> = "project-main",
  ) {
    const identity = yield* ProjectIdentity("pr", { ...props, project });
    yield* InstalledToken("Installed", {
      id: identity.id,
      project: identity.project,
    });
    return identity;
  });
  const outputProjectResources = Effect.gen(function* () {
    const project = yield* Project("ReplacementProject", { id: "project-other" });
    return yield* resources(declaration, project.id);
  });

  return {
    world,
    findIdentity,
    requiredIdentity,
    providers,
    api,
    resources,
    outputProjectResources,
  };
};

const options = {
  retry: 0,
  timeout: 90_000,
  tags: ["unit", "provider:infisical", "provider:infisical:projectidentity"],
};

const creation = harness();
creation.api.test.provider(
  "creates permanent roles and default OIDC, retains identity and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity } = creation;
      yield* stack.destroy();
      const first = yield* stack.deploy(resources());
      const remote = requiredIdentity(first.id);
      expect(first.project).toBe("project-main");
      expect(first.name).toMatch(/^pull-request-[a-z2-7]{16}$/);
      expect(remote.roles).toEqual([
        { role: "deployer", isTemporary: false },
        { role: "reader", isTemporary: false },
      ]);
      expect(remote.oidc).toEqual(wireDefaults);
      const again = yield* stack.deploy(
        resources({
          ...declaration,
          roles: ["deployer", "reader", "reader"],
        }),
      );
      expect(again).toEqual(first);
      expect(world.identities.size).toBe(1);
      yield* stack.destroy();
      expect(world.installedId).toBe("");
      expect(world.identities.size).toBe(0);
    }),
  options,
);

const update = harness();
update.api.test.provider(
  "updates name, permanent roles and OIDC in place, repairs drift and resets defaults",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity } = update;
      yield* stack.destroy();
      const first = yield* stack.deploy(resources());
      const changed = {
        name: "release",
        roles: ["release-manager"] as const,
        oidcAuth: {
          oidcDiscoveryUrl: "https://issuer.test/.well-known/openid-configuration",
          boundIssuer: "https://issuer.test",
          boundAudiences: ["deployment", "secrets"],
          boundSubject: "repo:heartbeat:ref:refs/heads/develop",
          boundClaims: { repository: "heartbeat", ref: "refs/heads/develop" },
          claimMetadataMapping: { repository: "repository-name" },
          caCert: "test-ca",
          accessTokenTTL: 600,
          accessTokenMaxTTL: 1200,
          accessTokenNumUsesLimit: 3,
          accessTokenTrustedIps: ["10.0.0.0/8", "192.0.2.1"],
        },
      };
      const updated = yield* stack.deploy(resources(changed));
      const remote = requiredIdentity(first.id);
      expect(updated.id).toBe(first.id);
      expect(updated.name).toBe(first.name.replace("pull-request-", "release-"));
      expect(updated.roles).toEqual(["release-manager"]);
      expect(updated.oidcAuth).toEqual(changed.oidcAuth);
      expect(remote.oidc).toEqual({
        ...changed.oidcAuth,
        boundAudiences: "deployment,secrets",
        accessTokenTrustedIps: [{ ipAddress: "10.0.0.0/8" }, { ipAddress: "192.0.2.1" }],
        templateId: null,
      });
      remote.name = "renamed-outside-alchemy";
      remote.roles = [
        { role: "admin", isTemporary: false },
        { role: "release-manager", isTemporary: true },
      ];
      remote.oidc = { ...wireDefaults, boundIssuer: "https://untrusted.test" };
      const restored = yield* stack.deploy(resources(changed));
      expect(restored).toEqual(updated);
      expect(remote.name).toBe(updated.name);
      expect(remote.roles).toEqual([{ role: "release-manager", isTemporary: false }]);
      expect(remote.oidc.boundIssuer).toBe("https://issuer.test");
      remote.oidc = undefined;
      const reattached = yield* stack.deploy(resources(changed));
      expect(reattached.id).toBe(first.id);
      expect(reattached.oidcAuth).toEqual(changed.oidcAuth);
      const defaults = yield* stack.deploy(resources());
      expect(defaults.id).toBe(first.id);
      expect(remote.name).toBe(first.name);
      expect(remote.oidc).toEqual(wireDefaults);
      expect(defaults.roles).toEqual(["deployer", "reader"]);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

for (const kind of ["literal", "output-valued"] as const) {
  const replacement = harness();
  replacement.api.test.provider(
    `replaces an identity for ${kind === "literal" ? "a" : "an"} ${kind} project only after its consumer switches`,
    (stack) =>
      Effect.gen(function* () {
        const { world, resources, requiredIdentity, findIdentity } = replacement;
        const replacementResources =
          kind === "literal"
            ? resources(declaration, "project-other")
            : replacement.outputProjectResources;
        yield* stack.destroy();
        const first = yield* stack.deploy(resources());
        const original = requiredIdentity(first.id);
        world.failConsumer = true;
        const failed = yield* Effect.exit(stack.deploy(replacementResources));
        world.failConsumer = false;
        expect(Exit.isFailure(failed)).toBe(true);
        expect(world.installedId).toBe(first.id);
        expect(findIdentity(first.id)).toEqual(original);
        expect(original.project).toBe("project-main");
        expect(original.roles).toEqual([
          { role: "deployer", isTemporary: false },
          { role: "reader", isTemporary: false },
        ]);
        const replaced = yield* stack.deploy(replacementResources);
        expect(replaced.id).not.toBe(first.id);
        expect(replaced.project).toBe("project-other");
        expect(world.installedId).toBe(replaced.id);
        expect(findIdentity(first.id)).toBeUndefined();
        expect(world.identities.size).toBe(1);
        yield* stack.destroy();
        expect(world.identities.size).toBe(0);
      }),
    options,
  );
}

const recreation = harness();
recreation.api.test.provider(
  "recreates an identity removed outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity } = recreation;
      yield* stack.destroy();
      const first = yield* stack.deploy(resources());
      world.identities.delete(first.id);
      const recovered = yield* stack.deploy(resources());
      expect(recovered.id).not.toBe(first.id);
      expect(world.installedId).toBe(recovered.id);
      expect(requiredIdentity(recovered.id).oidc).toEqual(wireDefaults);
      expect(world.identities.size).toBe(1);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

const cleanup = harness();
cleanup.api.test.provider(
  "cleans up a newly created identity when attaching OIDC fails and retries",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity } = cleanup;
      yield* stack.destroy();
      world.failAttach = true;
      const failed = yield* Effect.exit(stack.deploy(resources()));
      world.failAttach = false;
      expect(Exit.isFailure(failed)).toBe(true);
      expect(world.identities.size).toBe(0);
      const retried = yield* stack.deploy(resources());
      expect(world.installedId).toBe(retried.id);
      expect(requiredIdentity(retried.id).oidc).toEqual(wireDefaults);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

const ambiguity = harness();
ambiguity.api.test.provider(
  "rejects ambiguous instance suffixes and adopts an identity with an earlier prefix",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity, findIdentity } = ambiguity;
      yield* stack.destroy();
      world.failAttach = true;
      world.failDelete = true;
      const failed = yield* Effect.exit(stack.deploy(resources()));
      world.failAttach = false;
      world.failDelete = false;
      expect(Exit.isFailure(failed)).toBe(true);
      const existing = [...world.identities.values()][0];
      assert(existing, "The interrupted deployment left no identity");
      const physicalName = existing.name;
      existing.name = existing.name.replace(/^pull-request-/, "earlier-");
      const duplicate = {
        ...existing,
        id: "duplicate-identity",
        name: existing.name.replace(/^earlier-/, "other-"),
      };
      world.identities.set(duplicate.id, duplicate);
      const ambiguous = yield* Effect.exit(stack.deploy(resources()));
      assert(Exit.isFailure(ambiguous), "Ambiguous instance ownership was accepted");
      const diagnostic = Cause.pretty(ambiguous.cause);
      for (const identity of [existing, duplicate]) {
        expect(diagnostic).toContain(`${identity.name} (${identity.id})`);
      }
      expect(findIdentity(existing.id)).toEqual(existing);
      expect(findIdentity(duplicate.id)).toEqual(duplicate);
      expect(world.identities.size).toBe(2);
      expect(world.installedId).toBe("");
      world.identities.delete(duplicate.id);
      const adopted = yield* stack.deploy(resources());
      expect(adopted.id).toBe(existing.id);
      expect(adopted.name).toBe(physicalName);
      expect(requiredIdentity(adopted.id).name).toBe(physicalName);
      expect(world.installedId).toBe(adopted.id);
      expect(world.identities.size).toBe(1);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

const convergence = harness();
convergence.api.test.provider(
  "rejects an API that acknowledges updates without converging",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity } = convergence;
      yield* stack.destroy();
      const first = yield* stack.deploy(resources());
      world.ignoreUpdates = true;
      const failed = yield* Effect.exit(
        stack.deploy(resources({ ...declaration, roles: ["admin"] })),
      );
      world.ignoreUpdates = false;
      expect(Exit.isFailure(failed)).toBe(true);
      expect(world.installedId).toBe(first.id);
      expect(requiredIdentity(first.id).roles).toEqual([
        { role: "deployer", isTemporary: false },
        { role: "reader", isTemporary: false },
      ]);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

for (const recovery of [
  { description: "original name", name: "pull-request", renamePrefix: false },
  { description: "different truncated prefix", name: "a".repeat(80), renamePrefix: true },
]) {
  const interruptedCase = harness();
  interruptedCase.api.test(
    `destroys an identity whose state commit failed (${recovery.description})`,
    Effect.gen(function* () {
      const { world, providers, api } = interruptedCase;
      const store = yield* State.InMemoryService({});
      let failCommit = true;
      const set: State.StateService["set"] = (request) =>
        failCommit &&
        "resourceType" in request.value &&
        request.value.resourceType === "Infisical.ProjectIdentity" &&
        request.value.status === "created"
          ? Effect.fail(
              new State.StateStoreError({
                message: "State store unavailable after physical identity creation",
              }),
            )
          : store.set(request);
      const state = Layer.succeed(State.State, Effect.succeed({ ...store, set }));
      const interrupted = Stack.Stack(
        `InfisicalInterruptedCreationDestroy-${recovery.renamePrefix ? "truncated" : "original"}`,
        { providers, state },
        ProjectIdentity("pr", {
          ...declaration,
          name: recovery.name,
          project: "project-main",
        }),
      );
      yield* api.destroy(interrupted);
      const failed = yield* Effect.exit(api.deploy(interrupted));
      failCommit = false;
      expect(Exit.isFailure(failed)).toBe(true);
      const existing = [...world.identities.values()][0];
      assert(existing, "The completed creation left no physical identity");
      expect(existing.oidc).toEqual(wireDefaults);
      expect(world.identities.size).toBe(1);
      if (recovery.renamePrefix) {
        expect(existing.name).toHaveLength(64);
        expect(existing.name).not.toContain("-");
        existing.name = existing.name.replace(/^a/, "b");
      }
      yield* api.destroy(interrupted);
      expect(world.identities.size).toBe(0);
    }),
    options,
  );
}
