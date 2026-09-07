import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const KV = Cloudflare.KV.Namespace("DurableObjectWorkerEnvironmentKV", {
  title: "durable-object-worker-environment-kv",
});

/** A typed failure an RPC method raises; the stub must hand callers an instance. */
export class MissingKey extends Schema.TaggedError<MissingKey>()("MissingKey", {
  key: Schema.String,
}) {}

export class WorkerEnvironmentKVObject extends Cloudflare.DurableObject<WorkerEnvironmentKVObject>()(
  "WorkerEnvironmentKVObject",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);

    return Effect.gen(function* () {
      return {
        put: (key: string, value: string) => kv.put(key, value),
        get: (key: string) => kv.get(key),
        // Fails with a Schema.TaggedError so the test can check that the stub
        // decodes it back into an instance (see `errors` below).
        require: (key: string) =>
          kv
            .get(key)
            .pipe(
              Effect.flatMap((value) =>
                value === null || value === undefined
                  ? Effect.fail(new MissingKey({ key }))
                  : Effect.succeed(value),
              ),
            ),
        // The Cloudflare colo this instance is running in, as reported by a
        // subrequest it makes itself (a subrequest is served by the
        // datacenter the caller runs in, so the trace names *this* DO's
        // colo). Used to observe where `locationHint` placed the instance.
        colo: () =>
          Effect.promise(async () => {
            const response = await fetch(
              "https://cloudflare.com/cdn-cgi/trace",
            );
            const trace = await response.text();
            return trace.match(/^colo=(.*)$/m)?.[1] ?? "unknown";
          }),
        // Mirrors the `tick` example from the tutorial:
        // https://alchemy.run/cloudflare/compute/durable-objects
        // An RPC method that returns a Stream of sequential numbers.
        tick: (n: number) =>
          Stream.iterate(0, (i) => i + 1).pipe(
            Stream.take(n),
            Stream.schedule(Schedule.spaced("100 millis")),
          ),
      };
    });
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
  { errors: MissingKey },
) {}
