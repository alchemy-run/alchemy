/**
 * All-local stack for the credential-free `alchemy dev` proof
 * (test/credential-free.test.ts).
 *
 * Unlike ../../alchemy.run.ts, this stack has NO `Alchemy.remote()` /
 * `dev: { remote: true }` resources — those legitimately demand Cloudflare
 * credentials even during dev. Everything here is locally emulated, and
 * `Cloudflare.state()` resolves to the local file store in dev, so the whole
 * flow must boot with zero Cloudflare credentials.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CloudflareDevLocalOnly",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KV.Namespace("LocalKV");
    const worker = yield* Cloudflare.Worker("LocalOnlyWorker", {
      main: "./test/fixtures/local-only-worker.ts",
      env: {
        KV: kv,
      },
    });
    return {
      localOnlyWorker: worker.url,
      // `dev:` marker id — proof no cloud call created the namespace.
      kvNamespaceId: kv.namespaceId,
    };
  }),
);
