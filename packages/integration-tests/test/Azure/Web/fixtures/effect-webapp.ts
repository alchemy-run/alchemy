import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { distilledFromSource } from "./distilled-source.ts";

/** Storage account whose container the Effect web app reads and writes. */
export const WebAppData = Azure.Storage.StorageAccount("WebAppData");

/** Container behind the `BlobContainerReadWrite` binding. */
export const WebAppFiles = Effect.gen(function* () {
  const account = yield* WebAppData;
  return yield* Azure.Storage.BlobContainer("WebAppFiles", {
    storageAccount: account.storageAccountName,
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native web app on a Basic Linux plan: `/hello` reads a `Config`
 * value bound through app settings, `/blob/*` drive the
 * `Storage.BlobContainerReadWrite` binding as the app's managed identity.
 */
export default class EffectWebApp extends Azure.Web.WebApp<EffectWebApp>()(
  "EffectWebApp",
  {
    main: import.meta.url,
    location: "westus3",
    // B1: a free (F1) app answered "403 Web App - Unavailable" for minutes
    // after the redeploy's settings restart.
    sku: "B1",
    siteConfig: { alwaysOn: false },
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
    env: {
      GREETING: Config.String("AZURE_WEBAPP_EFFECT_GREETING").pipe(Config.withDefault("hello")),
    },
  },
  Effect.gen(function* () {
    const container = yield* WebAppFiles;
    const files = yield* Azure.Storage.BlobContainerReadWrite(container);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return HttpServerResponse.text(
              `${process.env.GREETING ?? "missing"} from app service on node ${process.versions.node}`,
            );
          case "/blob/write":
            return yield* respond(
              files.put(key, url.searchParams.get("value") ?? "", { contentType: "text/plain" }),
            );
          case "/blob/read":
            return yield* respond(
              Effect.map(files.get(key), (blob) => ({ text: blob?.text() ?? null })),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
