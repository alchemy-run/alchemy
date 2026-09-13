import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "node:path";
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "local rate-limit namespace shares counters across bindings and Workers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const workers = yield* stack.deploy(
        Effect.gen(function* () {
          const props = {
            main: Path.resolve(import.meta.dirname, "fixtures/local-worker.ts"),
            env: {
              FIRST: Cloudflare.RateLimit("First", {
                namespaceId: 27101,
                simple: { limit: 2, period: 60 },
              }),
              ALIAS: Cloudflare.RateLimit("Alias", {
                namespaceId: 27101,
                simple: { limit: 2, period: 60 },
              }),
              OTHER: Cloudflare.RateLimit("Other", {
                namespaceId: 27102,
                simple: { limit: 2, period: 60 },
              }),
            },
          };
          return [
            yield* Cloudflare.Worker("rate-local-one", props),
            yield* Cloudflare.Worker("rate-local-two", props),
          ];
        }),
      );
      const check = (worker: number, binding: string) =>
        Effect.promise(async () => {
          const response = await fetch(
            `${workers[worker]!.url}?binding=${binding}`,
          );
          return response.json() as Promise<{ success: boolean }>;
        });
      expect((yield* check(0, "FIRST")).success).toBe(true);
      expect((yield* check(0, "ALIAS")).success).toBe(true);
      expect((yield* check(1, "FIRST")).success).toBe(false);
      expect((yield* check(1, "OTHER")).success).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
