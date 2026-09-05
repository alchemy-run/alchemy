import { SecretManager as SecretManagerService } from "@/SecretManager.ts";
import {
  makeSecretManager,
  type SecretsSelector,
} from "@/Infisical/SecretManager.ts";
import { expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type Fetch = NonNullable<Parameters<typeof makeSecretManager>[1]>;

const read = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Config.string(name).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

const resolve = (
  selector: SecretsSelector,
  fetch: Fetch,
  fallback: ConfigProvider.ConfigProvider,
  stack = "payments",
  stage: string | undefined = "preview",
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeSecretManager(selector, fetch));
    return yield* Effect.provideService(
      Context.get(context, SecretManagerService).resolve({ stack, stage }),
      ConfigProvider.ConfigProvider,
      fallback,
    );
  });

const selection: SecretsSelector = ({ stack, stage }) => ({
  projectId: `project-${stack}`,
  environment: stage ?? "dev",
  secretPath: "/services",
});

it("exports the adapter from alchemy/Infisical", async () => {
  const adapter = await import("alchemy/Infisical");
  expect(adapter.secrets).toBeTypeOf("function");
});

it.effect("maps stack and stage and returns only Infisical values", () =>
  Effect.gen(function* () {
    let requestUrl: URL | undefined;
    let authorization: string | null = null;
    let redirect: RequestRedirect | undefined;
    const fetch: Fetch = async (input, init) => {
      requestUrl = new URL(input.toString());
      authorization = new Headers(init?.headers).get("authorization");
      redirect = init?.redirect;
      return new Response(
        JSON.stringify({
          imports: [
            {
              secrets: [
                { secretKey: "IMPORTED", secretValue: "imported" },
                { secretKey: "SHARED", secretValue: "imported" },
              ],
            },
          ],
          secrets: [
            { secretKey: "API_KEY", secretValue: "infisical-secret" },
            { secretKey: "SHARED", secretValue: "direct" },
          ],
        }),
        { status: 200 },
      );
    };
    const fallback = ConfigProvider.fromUnknown({
      INFISICAL_TOKEN: "st.test-token",
      FALLBACK_ONLY: "fallback",
    });

    const provider = yield* resolve(selection, fetch, fallback);

    expect(requestUrl).toBeDefined();
    const url = requestUrl!;
    expect(url.origin + url.pathname).toBe(
      "https://app.infisical.com/api/v4/secrets",
    );
    expect(url.searchParams.get("projectId")).toBe("project-payments");
    expect(url.searchParams.get("environment")).toBe("preview");
    expect(url.searchParams.get("secretPath")).toBe("/services");
    expect(url.searchParams.get("expandSecretReferences")).toBe("true");
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("includePersonalOverrides")).toBe("false");
    expect(url.toString()).not.toContain("st.test-token");
    expect(authorization).toBe("Bearer st.test-token");
    expect(redirect).toBe("error");
    expect(yield* read(provider, "API_KEY")).toBe("infisical-secret");
    expect(yield* read(provider, "IMPORTED")).toBe("imported");
    expect(yield* read(provider, "SHARED")).toBe("direct");
    const fallbackOnly = yield* Config.option(
      Config.string("FALLBACK_ONLY"),
    ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    expect(fallbackOnly._tag).toBe("None");
  }),
);

it.effect("uses Universal Auth and a configured API URL", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetch: Fetch = async (input, init) => {
      const url = new URL(input.toString());
      requests.push({ url, init });
      if (url.pathname.endsWith("/auth/universal-auth/login")) {
        return new Response(JSON.stringify({ accessToken: "short-lived" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          secrets: [{ secretKey: "API_KEY", secretValue: "secret" }],
        }),
        { status: 200 },
      );
    };
    const fallback = ConfigProvider.fromUnknown({
      INFISICAL_API_URL: "https://infisical.internal/base/",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "client-secret",
      INFISICAL_AUTH_ORGANIZATION_SLUG: "platform",
    });

    yield* resolve(selection, fetch, fallback);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url.toString()).toBe(
      "https://infisical.internal/base/api/v1/auth/universal-auth/login",
    );
    expect(requests[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      organizationSlug: "platform",
    });
    expect(requests[0]!.init?.redirect).toBe("error");
    expect(requests[1]!.url.origin + requests[1]!.url.pathname).toBe(
      "https://infisical.internal/base/api/v4/secrets",
    );
    expect(new Headers(requests[1]!.init?.headers).get("authorization")).toBe(
      "Bearer short-lived",
    );
  }),
);

it.effect("can omit imported secrets", () =>
  Effect.gen(function* () {
    const provider = yield* resolve(
      () => ({
        projectId: "project",
        environment: "dev",
        includeImports: false,
      }),
      async () =>
        new Response(
          JSON.stringify({
            imports: [
              { secrets: [{ secretKey: "IMPORTED", secretValue: "value" }] },
            ],
            secrets: [{ secretKey: "DIRECT", secretValue: "value" }],
          }),
        ),
      ConfigProvider.fromUnknown({ INFISICAL_TOKEN: "token" }),
    );

    expect(yield* read(provider, "DIRECT")).toBe("value");
    const imported = yield* Config.option(Config.string("IMPORTED")).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    );
    expect(imported._tag).toBe("None");
  }),
);

it.effect("forwards secret-set options to Infisical", () =>
  Effect.gen(function* () {
    let requestUrl: URL | undefined;
    yield* resolve(
      () => ({
        projectId: "project",
        environment: "prod",
        recursive: true,
        expandSecretReferences: false,
        includePersonalOverrides: true,
      }),
      async (input) => {
        requestUrl = new URL(input.toString());
        return new Response(JSON.stringify({ secrets: [] }));
      },
      ConfigProvider.fromUnknown({ INFISICAL_TOKEN: "token" }),
    );

    expect(requestUrl?.searchParams.get("recursive")).toBe("true");
    expect(requestUrl?.searchParams.get("expandSecretReferences")).toBe(
      "false",
    );
    expect(requestUrl?.searchParams.get("includePersonalOverrides")).toBe(
      "true",
    );
  }),
);

it.effect("reports missing Infisical authentication", () =>
  resolve(
    selection,
    async () => new Response("{}"),
    ConfigProvider.fromUnknown({}),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.manager).toBe("Infisical");
        expect(error.message).toContain("neither INFISICAL_TOKEN");
      }),
    ),
  ),
);

it.effect(
  "reports Universal Auth failures without exposing response bodies",
  () => {
    const responseBody = "do-not-expose-this-response";
    const clientSecret = "do-not-expose-this-client-secret";
    return resolve(
      selection,
      async () => new Response(responseBody, { status: 401 }),
      ConfigProvider.fromUnknown({
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "client-id",
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
      }),
    ).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("HTTP 401");
          expect(error.message).not.toContain(responseBody);
          expect(error.message).not.toContain(clientSecret);
        }),
      ),
    );
  },
);

it.effect("reports download failures without exposing response bodies", () => {
  const responseBody = "do-not-expose-this-response";
  const token = "do-not-expose-this-token";
  return resolve(
    selection,
    async () => new Response(responseBody, { status: 403 }),
    ConfigProvider.fromUnknown({ INFISICAL_TOKEN: token }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("HTTP 403");
        expect(error.message).not.toContain(responseBody);
        expect(error.message).not.toContain(token);
      }),
    ),
  );
});

it.effect("reports invalid Infisical payloads", () =>
  resolve(
    selection,
    async () =>
      new Response(
        JSON.stringify({
          secrets: [{ secretKey: "API_KEY", secretValue: { raw: "no" } }],
        }),
      ),
    ConfigProvider.fromUnknown({ INFISICAL_TOKEN: "token" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.message).toContain("invalid secrets payload");
      }),
    ),
  ),
);

it.effect("maps selector failures to SecretManagerError", () =>
  resolve(
    () => {
      throw new Error("unsafe selector detail");
    },
    async () => new Response("{}"),
    ConfigProvider.fromUnknown({ INFISICAL_TOKEN: "token" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("could not select");
        expect(error.message).not.toContain("unsafe selector detail");
      }),
    ),
  ),
);

it.effect("rejects invalid secret-set selections", () =>
  resolve(
    () => ({ projectId: "project", environment: "dev", secretPath: "bad" }),
    async () => new Response("{}"),
    ConfigProvider.fromUnknown({ INFISICAL_TOKEN: "token" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("invalid secret set");
      }),
    ),
  ),
);
