import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { CacheNetwork } from "./network.ts";

/**
 * Memcached instances take ~10 minutes to provision, so the suite is skipped
 * under `--fast`. `FAST` is forwarded to the host's environment so the
 * deployed runtime binds the same set.
 */
export const memcacheEnabled = !process.env.FAST;

/** Instance the binding is granted for, on its own Private Service Access network. */
export const Cache = Effect.gen(function* () {
  const authorizedNetwork = yield* CacheNetwork;
  return yield* GCP.Memcache.Instance("Cache", {
    location: "us-central1",
    authorizedNetwork,
  });
});

const instanceProbes = Effect.gen(function* () {
  const getInstance = yield* GCP.Memcache.GetInstance(Cache);
  return { getInstance: getInstance() };
});

/**
 * Effect-native Cloud Run service exercising the Memcache binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class MemcacheBindingsHost extends GCP.Function<MemcacheBindingsHost>()(
  "MemcacheBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: { FAST: memcacheEnabled ? "" : "1" },
  },
  Effect.gen(function* () {
    const instance = memcacheEnabled ? yield* instanceProbes : {};
    return { fetch: serveProbes({ ...instance }) };
  }).pipe(Effect.provide(GCP.Memcache.GetInstanceHttp)),
) {}
