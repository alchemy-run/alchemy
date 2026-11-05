// These deliberate API failures cannot safely or reliably be staged against a
// live test project. Normal resource lifecycle coverage is in ProjectIdentity.test.ts.
import { ProjectIdentity, ProjectIdentityProvider } from "@alchemy.run/infisical/ProjectIdentity";
import { Providers } from "@alchemy.run/infisical/Providers";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/infisical/Credentials";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
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
    loseCreateResponse: false,
  };
  const findIdentity = (id: string) => world.identities.get(id);
  const requiredIdentity = (id: string) => {
    const identity = world.identities.get(id);
    assert(identity);
    return identity;
  };
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
            if (world.loseCreateResponse) {
              world.loseCreateResponse = false;
              return answer({ message: "Gateway lost the successful create response" }, 502);
            }
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
            identity.name = body.name;
            return answer({ identity: identityJson(identity) });
          }
          if (request.method === "DELETE") {
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
      }
      return yield* Effect.die(`Unexpected ${request.method} ${url.href}`);
    }),
  );

  const providers = Layer.effect(Providers, Provider.collection([ProjectIdentity])).pipe(
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
  );
  const api = Test.make({ providers });
  const resources = (name = declaration.name) =>
    ProjectIdentity("pr", {
      ...declaration,
      name,
      project: "project-main",
    });
  return { world, findIdentity, requiredIdentity, api, resources };
};

const options = {
  retry: 0,
  timeout: 90_000,
  tags: ["unit", "provider:infisical", "provider:infisical:projectidentity"],
};

const cleanup = harness();
cleanup.api.test.provider(
  "cleans up a created identity when OIDC attachment fails, then retries",
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
      expect(requiredIdentity(retried.id).oidc).toEqual(wireDefaults);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

const ambiguity = harness();
ambiguity.api.test.provider(
  "rejects ambiguous suffix matches before recovering the interrupted identity",
  (stack) =>
    Effect.gen(function* () {
      const { world, resources, requiredIdentity, findIdentity } = ambiguity;
      yield* stack.destroy();
      world.loseCreateResponse = true;
      const failed = yield* Effect.exit(stack.deploy(resources()));
      expect(Exit.isFailure(failed)).toBe(true);
      const existing = [...world.identities.values()][0];
      assert(existing, "The lost response must leave the created identity");
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
      expect(existing.oidc).toBeUndefined();
      expect(world.identities.size).toBe(2);
      world.identities.delete(duplicate.id);
      const recovered = yield* stack.deploy(resources());
      expect(recovered.id).toBe(existing.id);
      expect(recovered.name).toBe(physicalName);
      expect(requiredIdentity(recovered.id).oidc).toEqual(wireDefaults);
      expect(world.identities.size).toBe(1);
      yield* stack.destroy();
      expect(world.identities.size).toBe(0);
    }),
  options,
);

for (const recovery of [
  { description: "original prefix", name: "pull-request", renamePrefix: false },
  { description: "changed truncated prefix", name: "a".repeat(80), renamePrefix: true },
]) {
  const lostResponse = harness();
  lostResponse.api.test.provider(
    `destroys an identity whose successful create response was lost (${recovery.description})`,
    (stack) =>
      Effect.gen(function* () {
        const { world, resources } = lostResponse;
        yield* stack.destroy();
        world.loseCreateResponse = true;
        const failed = yield* Effect.exit(stack.deploy(resources(recovery.name)));
        expect(Exit.isFailure(failed)).toBe(true);
        const existing = [...world.identities.values()][0];
        assert(existing, "The successful create must survive its lost response");
        expect(existing.oidc).toBeUndefined();
        expect(world.identities.size).toBe(1);
        if (recovery.renamePrefix) {
          expect(existing.name).toHaveLength(64);
          expect(existing.name).not.toContain("-");
          existing.name = existing.name.replace(/^a/, "b");
        }
        yield* stack.destroy();
        expect(world.identities.size).toBe(0);
      }),
    options,
  );
}
