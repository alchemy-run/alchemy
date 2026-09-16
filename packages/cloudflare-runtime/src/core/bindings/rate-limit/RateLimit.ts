import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Loopback from "../Loopback.ts";
import type * as LoopbackPlugin from "../../globals/Loopback.ts";
import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

const RateLimitBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/rate-limit/RateLimitBinding.worker",
    ),
};

export class RateLimit extends Plugin.Service<
  RateLimit,
  {
    readonly consume: (
      namespace: string,
      key: string,
      limit: number,
      period: number,
    ) => boolean;
  }
>()("cloudflare-runtime/plugin/RateLimit") {}

export const RateLimitLive = Layer.effect(
  RateLimit,
  Effect.gen(function* () {
    // Runtime-scoped host state is shared by every local Worker and binding.
    // Workerd isolates alone cannot share namespace counters across Workers.
    const buckets = new Map<string, { count: number; resetAt: number }>();
    const esModule = yield* formatExtensionModule(RateLimitBindingWorker);
    return RateLimit.of({
      extensions: [
        {
          modules: [
            { name: "cloudflare-runtime:rate-limit", internal: true, esModule },
          ],
        },
      ],
      api: {
        consume: (namespace, key, limit, period) => {
          const now = Date.now();
          const id = JSON.stringify([namespace, key, period]);
          let bucket = buckets.get(id);
          if (!bucket || now >= bucket.resetAt) {
            for (const [id, old] of buckets)
              if (now >= old.resetAt) buckets.delete(id);
            bucket = { count: 0, resetAt: now + period * 1000 };
            buckets.set(id, bucket);
          }
          if (bucket.count >= limit) return false;
          bucket.count++;
          return true;
        },
      },
    });
  }),
);

export const local = (
  props: RateLimitProps,
): BindingHook<RateLimit | LoopbackPlugin.Loopback> =>
  Plugin.use(RateLimit, (rateLimit) =>
    Effect.gen(function* () {
      const fetcher = yield* Loopback.local({
        binding: "FETCHER",
        name: `ratelimit:${props.namespaceId}`,
        handler: async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const { key, limit, period } = JSON.parse(
            Buffer.concat(chunks).toString(),
          );
          const success = rateLimit.api.consume(
            String(props.namespaceId),
            key,
            limit,
            period,
          );
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ success }));
        },
      });
      return {
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-runtime:rate-limit",
          innerBindings: [
            { name: "PROPS", json: JSON.stringify(props) },
            fetcher,
          ],
        },
      };
    }),
  );
