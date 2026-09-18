import { adopt, Unowned } from "@/AdoptPolicy.ts";
import { Auth, AuthProvider, removedAuthSettings } from "@/Neon/Auth.ts";
import {
  AuthOAuthProvider,
  AuthOAuthProviderProvider,
} from "@/Neon/AuthOAuthProvider.ts";
import {
  AuthTrustedDomain,
  AuthTrustedDomainProvider,
} from "@/Neon/AuthTrustedDomain.ts";
import { DataApi, DataApiProvider } from "@/Neon/DataApi.ts";
import * as Layer from "effect/Layer";
import * as Output from "@/Output.ts";
import { Branch } from "@/Neon/Branch.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const { test } = Test.make({ providers: providers() });

const context = {
  id: "IdentityGuard",
  fqn: "IdentityGuard",
  instanceId: "identity-guard",
  oldBindings: [],
  newBindings: [],
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};

test.provider(
  "Auth recovery treats incomplete uncreated identities as absent and preserves existing ownership",
  () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Provider;
      const domain = yield* AuthTrustedDomain.Provider;
      const scope = {
        projectId: "recovery-project",
        branchId: "recovery-branch",
      };
      const origin = "https://recovery.example.com";
      const incompleteAuth = { branch: { ...scope } };
      const partialAuth = { branch: { ...scope } };
      const incompleteDomain = { auth: { ...scope }, domain: origin };
      const partialDomain = { auth: { ...scope }, domain: origin };
      const missingOrigin = { auth: { ...scope }, domain: origin };
      // Interrupted state can omit unresolved reference fields.
      yield* Effect.sync(() => {
        Reflect.deleteProperty(incompleteAuth, "branch");
        Reflect.deleteProperty(partialAuth.branch, "branchId");
        Reflect.deleteProperty(incompleteDomain, "auth");
        Reflect.deleteProperty(partialDomain.auth, "projectId");
        Reflect.deleteProperty(missingOrigin, "domain");
      });
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.method);
          expect(request.method).toBe("GET");
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/domains")
                ? {
                    domains: [{ domain: origin, auth_provider: "better_auth" }],
                  }
                : {
                    auth_provider: "better_auth",
                    auth_provider_project_id: "recovery-auth",
                    branch_id: scope.branchId,
                    db_name: "neondb",
                    created_at: "2026-01-01T00:00:00Z",
                    owned_by: "neon",
                    jwks_url: "https://auth.example.com/jwks",
                    base_url: "https://auth.example.com",
                  },
            ),
          );
        }),
      );
      yield* Effect.gen(function* () {
        for (const olds of [
          incompleteAuth,
          partialAuth,
          { branch: { projectId: scope.projectId, branchId: "" } },
          { project: { projectId: "" } },
        ]) {
          expect(
            yield* auth.read!({ ...context, olds, output: undefined }),
          ).toBeUndefined();
        }
        for (const olds of [
          incompleteDomain,
          partialDomain,
          missingOrigin,
          { auth: { projectId: "", branchId: scope.branchId }, domain: origin },
        ]) {
          expect(
            yield* domain.read!({ ...context, olds, output: undefined }),
          ).toBeUndefined();
        }
        expect(requests).toEqual([]);
        const authOutput = yield* auth.read!({
          ...context,
          olds: { branch: scope },
          output: undefined,
        });
        const domainOutput = yield* domain.read!({
          ...context,
          olds: { auth: scope, domain: origin },
          output: undefined,
        });
        expect(Unowned.is(authOutput)).toBe(true);
        expect(Unowned.is(domainOutput)).toBe(true);
        if (!authOutput || !domainOutput)
          return yield* Effect.fail(
            new Error("Expected observed Auth identities"),
          );
        expect(
          Unowned.is(
            yield* auth.read!({
              ...context,
              olds: incompleteAuth,
              output: authOutput,
            }),
          ),
        ).toBe(false);
        expect(
          Unowned.is(
            yield* domain.read!({
              ...context,
              olds: incompleteDomain,
              output: domainOutput,
            }),
          ),
        ).toBe(false);
        expect(
          yield* auth
            .reconcile({
              ...context,
              olds: undefined,
              news: { branch: scope },
              output: undefined,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
            ),
        ).toBe(true);
        expect(
          yield* domain
            .reconcile({
              ...context,
              olds: undefined,
              news: { auth: scope, domain: origin },
              output: undefined,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
            ),
        ).toBe(true);
        expect(requests).toHaveLength(6);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          SDK.Credentials,
          Effect.succeed({
            apiKey: Redacted.make("recovery-test"),
            apiBaseUrl: "https://neon.example.com",
          }),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AuthProvider(), AuthTrustedDomainProvider()),
      ),
    ),
);

test.provider(
  "Auth children plan unresolved identities as replacements and reject mismatched cached scope",
  () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Provider;
      const oauth = yield* AuthOAuthProvider.Provider;
      const domain = yield* AuthTrustedDomain.Provider;
      const data = yield* DataApi.Provider;
      const scope = { projectId: "owned-project", branchId: "owned-branch" };
      const changed = { ...scope, branchId: "other-branch" };
      const unresolved = { ...scope, branchId: Output.literal("other-branch") };
      const authOutput = {
        ...scope,
        database: "neondb",
        baseUrl: "https://auth.example.com",
        jwksUrl: "https://auth.example.com/jwks",
        name: undefined,
      };
      const oauthOutput = {
        ...scope,
        provider: "github" as const,
        type: "standard" as const,
        clientId: "client",
      };
      const domainOutput = { ...scope, domain: "https://app.example.com" };
      const dataOutput = {
        ...scope,
        database: "neondb",
        url: "https://data.example.com",
        status: "active",
        settings: undefined,
      };
      expect(
        yield* auth.diff!({
          ...context,
          olds: { branch: scope },
          news: { branch: unresolved },
          output: authOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* oauth.diff!({
          ...context,
          olds: { auth: scope, provider: "github" },
          news: { auth: unresolved, provider: "github" },
          output: oauthOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* domain.diff!({
          ...context,
          olds: { auth: scope, domain: domainOutput.domain },
          news: { auth: unresolved, domain: domainOutput.domain },
          output: domainOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* data.diff!({
          ...context,
          olds: { branch: scope, database: "neondb" },
          news: { branch: unresolved, database: "neondb" },
          output: dataOutput,
        }),
      ).toMatchObject({ action: "replace" });
      expect(
        yield* auth.diff!({
          ...context,
          olds: { branch: scope },
          news: { branch: scope, database: Output.literal("neondb") },
          output: authOutput,
        }),
      ).toBeUndefined();
      expect(
        yield* auth
          .reconcile({
            ...context,
            olds: { branch: scope },
            news: { branch: changed },
            output: authOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* oauth
          .reconcile({
            ...context,
            olds: { auth: scope, provider: "github" },
            news: { auth: changed, provider: "github" },
            output: oauthOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* domain
          .reconcile({
            ...context,
            olds: { auth: scope, domain: domainOutput.domain },
            news: { auth: changed, domain: domainOutput.domain },
            output: domainOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* data
          .reconcile({
            ...context,
            olds: { branch: scope, database: "neondb" },
            news: { branch: changed, database: "neondb" },
            output: dataOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidDataApiConfiguration", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
      expect(
        yield* auth
          .reconcile({
            ...context,
            olds: { branch: scope, allowLocalhost: false },
            news: { branch: scope, name: "must-not-apply" },
            output: authOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* oauth
          .reconcile({
            ...context,
            olds: { auth: scope, provider: "github", clientId: "client" },
            news: { auth: scope, provider: "github" },
            output: oauthOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidManagedAuth", () => Effect.succeed(true)),
          ),
      ).toBe(true);
      expect(
        yield* data
          .reconcile({
            ...context,
            olds: {
              branch: scope,
              database: "neondb",
              settings: { db_max_rows: 10 },
            },
            news: { branch: scope, database: "neondb", settings: {} },
            output: dataOutput,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidDataApiConfiguration", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AuthProvider(),
          AuthOAuthProviderProvider(),
          AuthTrustedDomainProvider(),
          DataApiProvider(),
        ),
      ),
    ),
);

test(
  "managed field removal checks nested settings and permits an explicit email provider switch",
  Effect.sync(() => {
    expect(
      removedAuthSettings(
        { magicLink: { enabled: true, expires_in: 10 } },
        { magicLink: { enabled: false } },
        ["magicLink"],
      ),
    ).toEqual(["magicLink.expires_in"]);
    expect(
      removedAuthSettings(
        { emailProvider: { type: "standard", host: "smtp.example.com" } },
        { emailProvider: { type: "shared" } },
        ["emailProvider"],
      ),
    ).toEqual([]);
  }),
);

test.provider(
  "managed Auth requires adoption and preserves user data after external disable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = Effect.gen(function* () {
        const project = yield* Project("AuthOwnershipProject", {
          region: "aws-us-east-2",
        });
        const branch = yield* Branch("AuthOwnershipBranch", { project });
        return { project, branch };
      });
      const existing = yield* stack.deploy(base);
      const request = {
        project_id: existing.branch.projectId,
        branch_id: existing.branch.branchId,
      };
      yield* SDK.createNeonAuth({ ...request, auth_provider: "better_auth" });
      const application = (takeOwnership: boolean) =>
        Effect.gen(function* () {
          const { branch } = yield* base;
          const auth = yield* Auth("OwnedAuth", {
            branch,
            name: "Owned managed auth",
            allowLocalhost: false,
          }).pipe(adopt(takeOwnership));
          return { auth };
        });
      const refusal = yield* stack
        .deploy(application(false))
        .pipe(Effect.result);
      expect(Result.isFailure(refusal)).toBe(true);
      yield* stack.deploy(application(true));
      expect((yield* SDK.getNeonAuth(request)).name).toBe("Owned managed auth");
      expect(
        (yield* SDK.getNeonAuthAllowLocalhost(request)).allow_localhost,
      ).toBe(false);
      yield* SDK.disableNeonAuth(request);
      const refused = yield* stack.deploy(application(false)).pipe(
        Effect.as(undefined),
        Effect.catchTag("Conflict", (error) => Effect.succeed(error.message)),
      );
      expect(refused).toBe(
        "The `neon_auth` schema already exists and cannot be automatically provisioned. Please drop the existing `neon_auth` schema before provisioning Neon Auth.",
      );
      yield* stack.destroy();
      expect(
        yield* SDK.getNeonAuth(request).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "Auth scope replacement retains both branches and leaves the old branch disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (second: boolean) =>
        Effect.gen(function* () {
          const project = yield* Project("AuthReplacementProject", {
            region: "aws-us-east-2",
          });
          const a = yield* Branch("AuthBranchA", { project });
          const b = second
            ? yield* Branch("AuthBranchB", { project })
            : undefined;
          const auth = yield* Auth("ReplacingAuth", { branch: b ?? a });
          const domain = yield* AuthTrustedDomain("ScopeOrigin", {
            auth,
            domain: "https://scope.example.com",
          });
          return { a, b, auth, domain };
        });
      const first = yield* stack.deploy(application(false));
      const replaced = yield* stack.deploy(application(true));
      expect(replaced.auth.branchId).toBe(replaced.b!.branchId);
      expect(replaced.domain.branchId).toBe(replaced.b!.branchId);
      expect(replaced.a.branchId).toBe(first.a.branchId);
      expect(
        yield* SDK.getNeonAuth({
          project_id: first.auth.projectId,
          branch_id: first.auth.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
