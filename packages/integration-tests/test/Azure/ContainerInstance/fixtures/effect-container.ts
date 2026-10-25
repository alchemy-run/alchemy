import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { distilledFromSource } from "./distilled-source.ts";

/** Storage account whose container the program reads and writes. */
export const AciData = Azure.Storage.StorageAccount("AciData");

/** Container the `/blob` route reads and writes through `BlobContainerReadWrite`. */
export const AciFiles = Effect.gen(function* () {
  const account = yield* AciData;
  return yield* Azure.Storage.BlobContainer("AciFiles", {
    storageAccount: account.storageAccountName,
  });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect program on a container group: `fetch` on port 3000, an env value
 * from `Config`, and one Azure binding exercised with the group's managed
 * identity.
 */
export default class EffectContainer extends Azure.ContainerInstance.ContainerGroup<EffectContainer>()(
  "EffectContainer",
  {
    main: import.meta.url,
    cpu: 0.5,
    memoryInGB: 1,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
    env: {
      GREETING: Config.String("AZURE_ACI_EFFECT_GREETING").pipe(Config.withDefault("hello")),
    },
  },
  Effect.gen(function* () {
    const files = yield* AciFiles;
    const blobs = yield* Azure.Storage.BlobContainerReadWrite(files);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return text(`${process.env.GREETING ?? "missing"} from aci`);
          case "/blob":
            return yield* respond(
              Effect.gen(function* () {
                yield* blobs.put(key, url.searchParams.get("value") ?? "", {
                  contentType: "text/plain",
                });
                const blob = yield* blobs.get(key);
                return { text: blob?.text() };
              }),
            );
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
