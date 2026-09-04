import { SecretManager as SecretManagerService } from "@/SecretManager.ts";
import {
  makeSecretManager,
  type SecretManagerOptions,
} from "@/Doppler/SecretManager.ts";
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
  options: SecretManagerOptions,
  fetch: Fetch,
  fallback: ConfigProvider.ConfigProvider,
  stack = "payments",
  stage: string | undefined = "preview",
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeSecretManager(options, fetch));
    return yield* Context.get(context, SecretManagerService).resolve({
      stack,
      stage,
      fallback,
    });
  });

it("exports the adapter from alchemy/Doppler", async () => {
  const adapter = await import("alchemy/Doppler");
  expect(adapter.SecretManager).toBeTypeOf("function");
});

it.effect("maps stack and stage to Doppler and preserves fallback values", () =>
  Effect.gen(function* () {
    let requestUrl: URL | undefined;
    let authorization: string | null = null;
    let redirect: RequestRedirect | undefined;
    const fetch: Fetch = async (input, init) => {
      requestUrl = new URL(input.toString());
      authorization = new Headers(init?.headers).get("authorization");
      redirect = init?.redirect;
      return new Response(
        JSON.stringify({ API_KEY: "doppler-secret", SHARED: "doppler" }),
        { status: 200 },
      );
    };
    const fallback = ConfigProvider.fromUnknown({
      DOPPLER_TOKEN: "dp.st.test-token",
      FALLBACK_ONLY: "fallback",
      SHARED: "fallback",
    });

    const provider = yield* resolve(
      {
        project: ({ stack }) => `alchemy-${stack}`,
        config: ({ stage }) => `stage-${stage}`,
      },
      fetch,
      fallback,
    );

    expect(requestUrl).toBeDefined();
    const url = requestUrl!;
    expect(url.origin + url.pathname).toBe(
      "https://api.doppler.com/v3/configs/config/secrets/download",
    );
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("project")).toBe("alchemy-payments");
    expect(url.searchParams.get("config")).toBe("stage-preview");
    expect(url.toString()).not.toContain("dp.st.test-token");
    expect(authorization).toBe("Bearer dp.st.test-token");
    expect(redirect).toBe("error");
    expect(yield* read(provider, "API_KEY")).toBe("doppler-secret");
    expect(yield* read(provider, "SHARED")).toBe("doppler");
    expect(yield* read(provider, "FALLBACK_ONLY")).toBe("fallback");
  }),
);

it.effect("omits project and config for a config-scoped service token", () =>
  Effect.gen(function* () {
    let requestUrl: URL | undefined;
    const fetch: Fetch = async (input) => {
      requestUrl = new URL(input.toString());
      return new Response(JSON.stringify({ API_KEY: "secret" }), {
        status: 200,
      });
    };

    yield* resolve(
      {},
      fetch,
      ConfigProvider.fromUnknown({ DOPPLER_TOKEN: "dp.st.test-token" }),
    );

    expect(requestUrl?.searchParams.has("project")).toBe(false);
    expect(requestUrl?.searchParams.has("config")).toBe(false);
  }),
);

it.effect("reports a missing Doppler token as a SecretManagerError", () =>
  resolve(
    {},
    async () => new Response("{}"),
    ConfigProvider.fromUnknown({}),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.manager).toBe("Doppler");
        expect(error.message).toContain("DOPPLER_TOKEN is not set");
      }),
    ),
  ),
);

it.effect("reports download failures without exposing response bodies", () => {
  const responseBody = "do-not-expose-this-response";
  const token = "dp.st.do-not-expose-this-token";
  return resolve(
    {},
    async () => new Response(responseBody, { status: 401 }),
    ConfigProvider.fromUnknown({ DOPPLER_TOKEN: token }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.message).toContain("HTTP 401");
        expect(error.message).not.toContain(responseBody);
        expect(error.message).not.toContain(token);
      }),
    ),
  );
});

it.effect("reports invalid Doppler payloads as SecretManagerError", () =>
  resolve(
    {},
    async () =>
      new Response(JSON.stringify({ API_KEY: { raw: "not-a-string" } }), {
        status: 200,
      }),
    ConfigProvider.fromUnknown({ DOPPLER_TOKEN: "dp.st.test-token" }),
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
    {
      project: () => {
        throw new Error("unsafe selector detail");
      },
    },
    async () => new Response("{}"),
    ConfigProvider.fromUnknown({ DOPPLER_TOKEN: "dp.st.test-token" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.message).toContain("could not select");
        expect(error.message).not.toContain("unsafe selector detail");
      }),
    ),
  ),
);
