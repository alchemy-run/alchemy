import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import PrismaHostStack from "./fixtures/prismahost/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Prisma.providers()),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * Regression for alchemy-run/alchemy#1334 on Linux: an arbitrary image given
 * a local Prisma `DATABASE_URL` (`postgres://…@127.0.0.1:…`) must be able to
 * reach `@prisma/dev` from inside the container. host-gateway rewrites the
 * hostname, but the server still has to accept connections on the Docker
 * bridge — a 127.0.0.1 listener times out with
 * `dial error: timeout` to `172.17.0.1`.
 */
describe("local container reaches Prisma Postgres", () => {
  const stack = beforeAll(deploy(PrismaHostStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(PrismaHostStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "container DATABASE_URL is rewritten once and reaches the host Prisma",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;

      const get = (path: string) =>
        client.get(new URL(path, url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200
              ? Effect.fail(new Error(`not ready: ${r.status}`))
              : r.text,
          ),
          Effect.timeout("30 seconds"),
          Effect.retry({ schedule: readinessSchedule, times: 30 }),
        );

      const env = JSON.parse(yield* get("/env")) as {
        DATABASE_URL: string;
        databaseUrlCount?: number;
      };
      const databaseUrl = new URL(env.DATABASE_URL);
      expect(databaseUrl.hostname).not.toBe("localhost");
      expect(databaseUrl.hostname).not.toBe("127.0.0.1");
      expect(databaseUrl.hostname).toContain("localhost");
      // glibc getenv is first-match: a leftover un-rewritten copy would win.
      if (env.databaseUrlCount !== undefined) {
        expect(env.databaseUrlCount).toBe(1);
      }

      const probe = JSON.parse(yield* get("/probe")) as {
        ok?: boolean;
        host?: string;
        error?: string;
      };
      expect(probe.error).toBeUndefined();
      expect(probe.ok).toBe(true);
      expect(probe.host).toBe(databaseUrl.hostname);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
