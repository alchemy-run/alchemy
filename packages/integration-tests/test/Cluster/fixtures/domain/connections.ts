/**
 * How many connections the pool's runners hold to the cluster's database,
 * read from Postgres's own `pg_stat_activity` while both models it hosts
 * take a burst of commands.
 */
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { DOMAIN_DATABASE_CONNECTIONS, DOMAIN_RUNNERS as RUNNERS } from "./cluster.ts";
import { docker } from "./crash.ts";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly exclusive?: boolean },
) => void;

export interface ConnectionsOptions {
  readonly test: TestFn;
  readonly url: string;
  readonly stack: { readonly name: string; readonly stage: string };
}

/** A route answered with an error. */
class RouteFailed extends Data.TaggedError("RouteFailed")<{
  readonly path: string;
  readonly status: number;
}> {}

/** The container of the cluster's Postgres service. */
const postgres = Effect.fn(function* (stack: ConnectionsOptions["stack"]) {
  const service = yield* docker([
    "service",
    "ls",
    "--filter",
    "label=alchemy::id=ClusterDomainPostgres",
    "--filter",
    `label=alchemy::stack=${stack.name}`,
    "--filter",
    `label=alchemy::stage=${stack.stage}`,
    "--format",
    "{{.Name}}",
  ]);
  const [container] = (yield* docker([
    "ps",
    "--filter",
    `label=com.docker.swarm.service.name=${service}`,
    "--format",
    "{{.ID}}",
  ])).split("\n");
  return container!;
});

/**
 * The connections clients hold to the cluster's database. Swarm's load
 * balancer gives every runner's connection the same source address, so
 * this counts them all: the front opens none, so they are the runners'.
 */
const databaseConnections = (container: string) =>
  docker([
    "exec",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "cluster",
    "-tAc",
    "SELECT count(*) FROM pg_stat_activity WHERE datname = 'cluster' AND client_addr IS NOT NULL",
  ]).pipe(Effect.map(Number));

export const connections = ({ test, url, stack }: ConnectionsOptions) =>
  test(
    "a runner hosting two models holds one storage pool, sized by the pool's databaseConnections",
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const container = yield* postgres(stack);
      const run = crypto.randomUUID().slice(0, 8);
      const send = (path: string) =>
        client.get(`${url}${path}`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.void
              : Effect.fail(new RouteFailed({ path, status: response.status })),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 10 }),
        );
      // The most connections the runners held at once, sampled through the burst.
      let most = 0;
      const sampler = yield* databaseConnections(container).pipe(
        Effect.tap((count) =>
          Effect.sync(() => {
            most = Math.max(most, count);
          }),
        ),
        Effect.repeat(Schedule.spaced("200 millis")),
        Effect.forkChild,
      );
      // Both models' storage, on many instances at once, on both runners.
      yield* Effect.forEach(
        Array.from({ length: 192 }, (_, i) =>
          i % 2 === 0 ? `/tick/${run}-${i % 48}` : `/increment/${run}-${i % 48}?by=1`,
        ),
        send,
        { concurrency: 48, discard: true },
      );
      yield* Effect.sleep("1 second");
      yield* Fiber.interrupt(sampler);
      // Each of the two runners: the cluster's own pool and one storage
      // pool, each of at most `databaseConnections`, however many models
      // the runner hosts.
      expect(most).toBeGreaterThan(0);
      expect(most).toBeLessThanOrEqual(RUNNERS * 2 * DOMAIN_DATABASE_CONNECTIONS);
    }),
    { timeout: 180_000 },
  );
