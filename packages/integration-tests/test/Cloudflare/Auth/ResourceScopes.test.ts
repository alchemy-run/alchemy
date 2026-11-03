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
import { ALL_SCOPES, OAUTH_SCOPE_NAMES } from "@alchemy.run/cloudflare/Auth/OAuthScopes";
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

    it("asks each type for the Cloudflare permissions its endpoints accept", () => {
      // Pinned by permission name, so a wrong scope id fails even when it is
      // a valid scope in the catalog.
      expect(
        Object.fromEntries(
          Object.entries(RESOURCE_OAUTH_SCOPES).map(([type, scopes]) => [
            type,
            scopes.map((scope) => OAUTH_SCOPE_NAMES[scope]),
          ]),
        ),
      ).toEqual({
        "Cloudflare.Access.Application": ["Access: Apps and Policies Write", "Access: Apps Write"],
        "Cloudflare.Access.Policy": ["Access: Apps and Policies Write", "Access: Policies Write"],
        "Cloudflare.Access.Bookmark": ["Access: Apps and Policies Write"],
        "Cloudflare.Access.Group": [
          "Access: Organizations, Identity Providers, and Groups Write",
          "Access: Groups Write",
        ],
        "Cloudflare.Access.IdentityProvider": [
          "Access: Organizations, Identity Providers, and Groups Write",
          "Access: Identity Providers Write",
        ],
        "Cloudflare.Access.Organization": [
          "Access: Organizations, Identity Providers, and Groups Write",
          "Access: Organizations Write",
        ],
        "Cloudflare.Access.ServiceToken": ["Access: Service Tokens Write"],
        "Cloudflare.Access.CustomPage": ["Access: Custom Pages Write"],
        "Cloudflare.Access.Certificate": ["Access: Mutual TLS Certificates Write"],
        "Cloudflare.Worker": ["Workers Scripts Write"],
        "Cloudflare.Workflow": ["Workers Scripts Write"],
        "Cloudflare.Workers.Route": ["Workers Routes Write"],
        "Cloudflare.D1Database": ["D1 Write"],
        "Cloudflare.R2.Bucket": ["Workers R2 Storage Write"],
        "Cloudflare.KV.Namespace": ["Workers KV Storage Write"],
        "Cloudflare.Queues.Queue": ["Queues Write", "Workers Scripts Write"],
        "Cloudflare.Hyperdrive": ["Hyperdrive Write"],
        "Cloudflare.VectorizeIndex": ["Vectorize Write"],
        "Cloudflare.SecretsStore": ["Secrets Store Write"],
        "Cloudflare.DNS.Record": ["DNS Write"],
        "Cloudflare.Tunnel.Tunnel": [
          "Cloudflare Tunnel Write",
          "Cloudflare One Connectors Write",
          "Cloudflare One Connector: cloudflared Write",
        ],
      });
    });

    it("names each missing scope once with the resources that need it", () => {
      const missing = missingOAuthScopes(
        ["workers-scripts.write", "d1.write"],
        [
          { Type: "Cloudflare.Worker", FQN: "Api" },
          { Type: "Cloudflare.D1Database", FQN: "Db" },
          { Type: "Cloudflare.Access.Application", FQN: "AdminApp" },
          { Type: "Cloudflare.Access.ServiceToken", FQN: "CiToken" },
          { Type: "Cloudflare.Access.Application", FQN: "DocsApp" },
          { Type: "Cloudflare.Access.Policy", FQN: "AdminPolicy" },
          { Type: "Cloudflare.Unmapped.Thing", FQN: "Other" },
        ],
      );
      expect(missing).toEqual([
        {
          scope: "access.write",
          alternatives: ["access-app.write"],
          resources: ["AdminApp", "DocsApp"],
        },
        { scope: "access-service-token.write", alternatives: [], resources: ["CiToken"] },
        {
          scope: "access.write",
          alternatives: ["access-policy.write"],
          resources: ["AdminPolicy"],
        },
      ]);
      const message = missingOAuthScopesMessage("default", missing, "Run `reconfigure`.");
      expect(message).toContain("profile 'default'");
      expect(message).toContain(
        "access.write (Access: Apps and Policies Write) or access-app.write: AdminApp, DocsApp",
      );
      expect(message).toContain(
        "access.write (Access: Apps and Policies Write) or access-policy.write: AdminPolicy",
      );
      expect(message).toContain(
        "access-service-token.write (Access: Service Tokens Write): CiToken",
      );
      expect(message).toContain("Run `reconfigure`.");
    });

    it("accepts the narrower Access scopes for the objects they cover", () => {
      const access = [
        { Type: "Cloudflare.Access.Application", FQN: "App" },
        { Type: "Cloudflare.Access.Policy", FQN: "Policy" },
        { Type: "Cloudflare.Access.Group", FQN: "Group" },
        { Type: "Cloudflare.Access.IdentityProvider", FQN: "Idp" },
        { Type: "Cloudflare.Access.Organization", FQN: "Org" },
      ];
      expect(
        missingOAuthScopes(
          [
            "access-app.write",
            "access-policy.write",
            "access-group.write",
            "access-idp.write",
            "access-org.write",
          ],
          access,
        ),
      ).toEqual([]);
      expect(missingOAuthScopes(["access.write", "access-acct.write"], access)).toEqual([]);
      // A narrow scope covers only its own objects.
      expect(
        missingOAuthScopes(["access-app.write", "access-group.write"], access).flatMap(
          (entry) => entry.resources,
        ),
      ).toEqual(["Policy", "Idp", "Org"]);
    });

    it("accepts any one of a resource's alternative scopes", () => {
      expect(
        missingOAuthScopes(
          ["workers-scripts.write"],
          [{ Type: "Cloudflare.Queues.Queue", FQN: "Jobs" }],
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
