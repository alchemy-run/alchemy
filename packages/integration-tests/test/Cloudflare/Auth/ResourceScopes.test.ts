import { Application } from "@alchemy.run/cloudflare/Access/Application";
import { Bookmark } from "@alchemy.run/cloudflare/Access/Bookmark";
import { Certificate } from "@alchemy.run/cloudflare/Access/Certificate";
import { CustomPage } from "@alchemy.run/cloudflare/Access/CustomPage";
import { Group } from "@alchemy.run/cloudflare/Access/Group";
import { IdentityProvider } from "@alchemy.run/cloudflare/Access/IdentityProvider";
import { Organization } from "@alchemy.run/cloudflare/Access/Organization";
import { Policy } from "@alchemy.run/cloudflare/Access/Policy";
import { ServiceToken } from "@alchemy.run/cloudflare/Access/ServiceToken";
import type { CloudflareAuthConfig } from "@alchemy.run/cloudflare/Auth/AuthConfig";
import { CloudflareAuth } from "@alchemy.run/cloudflare/Auth/AuthProvider";
import { ALL_SCOPES } from "@alchemy.run/cloudflare/Auth/OAuthScopes";
import {
  missingOAuthScopes,
  missingOAuthScopesMessage,
  RESOURCE_OAUTH_SCOPES,
} from "@alchemy.run/cloudflare/Auth/ResourceScopes";
import { Database } from "@alchemy.run/cloudflare/D1/Database";
import { Record } from "@alchemy.run/cloudflare/DNS/Record";
import { Connection } from "@alchemy.run/cloudflare/Hyperdrive/Connection";
import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Queue } from "@alchemy.run/cloudflare/Queues/Queue";
import { Bucket } from "@alchemy.run/cloudflare/R2/Bucket";
import { Store } from "@alchemy.run/cloudflare/SecretsStore/SecretsStore";
import { Tunnel } from "@alchemy.run/cloudflare/Tunnel/Tunnel";
import { Index } from "@alchemy.run/cloudflare/Vectorize/VectorizeIndex";
import { WorkerRoute } from "@alchemy.run/cloudflare/Workers/Route";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkflowResource } from "@alchemy.run/cloudflare/Workflows/Workflow";
import { describe, expect, it } from "@alchemy.run/test";
import { AuthProvidersLive, getAuthProvider } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

describe(
  "Cloudflare OAuth scopes per resource type",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:auth"] },
  () => {
    it("maps only real resource types to scopes in the client catalog", () => {
      const types = [
        Application,
        Bookmark,
        Certificate,
        CustomPage,
        Group,
        IdentityProvider,
        Organization,
        Policy,
        ServiceToken,
        Database,
        Record,
        Connection,
        Namespace,
        Queue,
        Bucket,
        Store,
        Tunnel,
        Index,
        WorkerRoute,
        Worker,
        WorkflowResource,
      ].map((resource) => resource.Type);
      expect(Object.keys(RESOURCE_OAUTH_SCOPES).toSorted()).toEqual(types.toSorted());
      for (const scopes of Object.values(RESOURCE_OAUTH_SCOPES)) {
        expect(scopes.length).toBeGreaterThan(0);
        expect(scopes.every((scope) => scope in ALL_SCOPES)).toBe(true);
      }
    });

    it("names each missing scope once with the resources that need it", () => {
      const missing = missingOAuthScopes(
        ["workers-scripts.write", "d1.write"],
        [
          { Type: "Cloudflare.Worker", FQN: "Api" },
          { Type: "Cloudflare.D1Database", FQN: "Db" },
          { Type: "Cloudflare.Access.Application", FQN: "AdminApp" },
          { Type: "Cloudflare.Access.Policy", FQN: "AdminPolicy" },
          { Type: "Cloudflare.Access.ServiceToken", FQN: "CiToken" },
          { Type: "Cloudflare.Unmapped.Thing", FQN: "Other" },
        ],
      );
      expect(missing).toEqual([
        {
          scope: "access.write",
          alternatives: ["zone-access.write"],
          resources: ["AdminApp", "AdminPolicy"],
        },
        {
          scope: "access-service-token.write",
          alternatives: [],
          resources: ["CiToken"],
        },
      ]);
      const message = missingOAuthScopesMessage("default", missing, "Run `reconfigure`.");
      expect(message).toContain("profile 'default'");
      expect(message).toContain(
        "access.write (Access: Apps and Policies Write) or zone-access.write: AdminApp, AdminPolicy",
      );
      expect(message).toContain(
        "access-service-token.write (Access: Service Tokens Write): CiToken",
      );
      expect(message).toContain("Run `reconfigure`.");
    });

    it("accepts any one of a resource's alternative scopes", () => {
      expect(
        missingOAuthScopes(
          ["zone-access.write", "workers-scripts.write"],
          [
            { Type: "Cloudflare.Access.Application", FQN: "ZoneApp" },
            { Type: "Cloudflare.Queues.Queue", FQN: "Jobs" },
          ],
        ),
      ).toEqual([]);
    });

    it.effect("fails an OAuth profile's preflight and passes API tokens", () =>
      Effect.gen(function* () {
        const auth = yield* getAuthProvider<CloudflareAuthConfig>("Cloudflare");
        const resources = [{ Type: "Cloudflare.Access.Application", FQN: "AdminApp" }];
        const error = yield* Effect.flip(
          auth.preflight!(
            "default",
            {
              method: "oauth",
              scopes: ["workers-scripts.write"],
              accountId: "account",
              access: "access",
              refresh: "refresh",
              expires: 0,
            },
            resources,
          ),
        );
        expect(error._tag).toBe("AuthError");
        expect(error.message).toContain("access.write");
        expect(error.message).toContain("--reconfigure Cloudflare");
        yield* auth.preflight!(
          "default",
          { method: "stored", credentialType: "apiToken", apiToken: "token", accountId: "account" },
          resources,
        );
      }).pipe(
        Effect.provide(
          CloudflareAuth.pipe(
            Layer.provideMerge(AuthProvidersLive),
            Layer.provide(CredentialsStoreLive),
            Layer.provide(PlatformServices),
          ),
        ),
      ),
    );
  },
);
