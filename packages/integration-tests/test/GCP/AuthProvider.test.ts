import {
  GCP_AUTH_PROVIDER_NAME,
  GcpAuth,
  parseGcloudLoginOutput,
  type GcpAuthConfig,
  type GcpResolvedCredentials,
} from "@alchemy.run/gcp/AuthProvider";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthProviders, getAuthProvider } from "alchemy/Auth/AuthProvider";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import * as Interaction from "alchemy/Interaction";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

const credentialsStore: CredentialsStore["Service"] = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  delete: () => Effect.void,
  deleteProfile: () => Effect.void,
  scoped: () => credentialsStore,
};

const testLayer = (env: Record<string, string>) =>
  GcpAuth.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(AuthProviders, {}),
        Layer.succeed(CredentialsStore, credentialsStore),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        Interaction.layerNonInteractive(),
      ),
    ),
  );

const readGcloud = (config: Omit<Extract<GcpAuthConfig, { method: "gcloud" }>, "method"> = {}) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<GcpAuthConfig, GcpResolvedCredentials>(
      GCP_AUTH_PROVIDER_NAME,
    );
    return yield* auth.read("default", { method: "gcloud", ...config });
  });

/** Runs `effect` with gcloud's config directory set to a fresh one holding `adc`. */
const withGcloudConfig = <A, E, R>(adc: object | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-gcloud-" });
    if (adc !== undefined) {
      yield* fs.writeFileString(
        path.join(dir, "application_default_credentials.json"),
        JSON.stringify(adc),
      );
    }
    return yield* effect.pipe(Effect.provide(testLayer({ CLOUDSDK_CONFIG: dir })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// gcloud's own OAuth client: public by design (it ships in the CLI).
const gcloudClient = {
  client_id: "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com",
  client_secret: "d-FL95Q19q7MQmFpd7hHD0Ty",
};

describe("parseGcloudLoginOutput", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("reads the authorization URL from gcloud's prompt", () => {
    expect(
      parseGcloudLoginOutput(`Your browser has been opened to visit:

    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F

`),
    ).toBe(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F",
    );
  });

  it("waits until the URL has been printed", () => {
    expect(parseGcloudLoginOutput("Your browser has been opened to visit:\n")).toBeUndefined();
  });
});

describe("gcloud auth method", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it.effect("asks for a refresh when there is no gcloud login", () =>
    Effect.gen(function* () {
      const error = yield* withGcloudConfig(undefined, readGcloud({ project: "p" })).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("NeedsReauth");
      expect(error.message).toContain("alchemy profile refresh --profile default --provider GCP");
    }),
  );

  it.effect("rejects credential types gcloud login does not write", () =>
    Effect.gen(function* () {
      const error = yield* withGcloudConfig(
        { type: "impersonated_service_account", service_account_impersonation_url: "x" },
        readGcloud({ project: "p" }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Unsupported gcloud credentials");
    }),
  );
});

describe("gcloud auth method", { tags: ["provider:gcp", "live"] }, () => {
  it.live("asks for a refresh when Google rejects the refresh token", () =>
    withGcloudConfig(
      { type: "authorized_user", ...gcloudClient, refresh_token: "1//revoked" },
      readGcloud({ project: "p" }),
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("NeedsReauth");
        expect(error.message).toContain("gcloud credentials need to be refreshed");
      }),
    ),
  );
});

// Needs `gcloud auth application-default login` on this machine.
// Set GCP_TEST_GCLOUD_PROJECT to a project the signed-in user can read.
const gcloudProject = process.env.GCP_TEST_GCLOUD_PROJECT;

describe.skipIf(!gcloudProject)(
  "gcloud auth method with a real login",
  { tags: ["provider:gcp", "live"] },
  () => {
    it.live("mints a token that calls Google APIs as the user", () =>
      Effect.gen(function* () {
        const credentials = yield* readGcloud({ project: gcloudProject! }).pipe(
          Effect.provide(testLayer({})),
        );
        expect(credentials.source.type).toBe("gcloud");
        expect(credentials.project).toBe(gcloudProject);
        expect(credentials.expiresAt).toBeGreaterThan(Date.now());

        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.get(
            `https://cloudresourcemanager.googleapis.com/v3/projects/${gcloudProject}`,
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.accessToken))),
        );
        expect(response.status).toBe(200);
        const project = (yield* response.json) as { projectId: string };
        expect(project.projectId).toBe(gcloudProject);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  },
);
