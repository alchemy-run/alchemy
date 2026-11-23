/**
 * Reads of the cluster's Postgres from outside the cluster, with `psql` in
 * its container: what the runners did, seen without calling the model.
 */
import * as Effect from "effect/Effect";
import { docker } from "./crash.ts";

/** A failed `docker` command. */
type DockerError = Effect.Error<ReturnType<typeof docker>>;

/** The deployed stack and stage: Postgres is a Swarm service of its database. */
export interface DeployedStack {
  readonly name: string;
  readonly stage: string;
}

/** The container of the cluster's Postgres service. */
export const clusterPostgres: (stack: DeployedStack) => Effect.Effect<string, DockerError> =
  Effect.fn(function* (stack: DeployedStack) {
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

/** Run `query` on the cluster's database: one line per row, columns split by `|`. */
export const psql = (
  container: string,
  query: string,
): Effect.Effect<ReadonlyArray<string>, DockerError> =>
  docker(["exec", container, "psql", "-U", "postgres", "-d", "cluster", "-tAc", query]).pipe(
    Effect.map((out) => (out === "" ? [] : out.split("\n"))),
  );
