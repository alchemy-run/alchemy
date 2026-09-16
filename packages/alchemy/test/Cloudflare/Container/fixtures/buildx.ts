import { Docker } from "@/Docker/Docker.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const withBuilder =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const docker = yield* Docker;
      return yield* Effect.acquireUseRelease(
        docker.run([
          "buildx",
          "create",
          "--name",
          name,
          "--driver",
          "docker-container",
        ]),
        () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const previous = {
                builder: process.env.BUILDX_BUILDER,
                attestations: process.env.BUILDX_NO_DEFAULT_ATTESTATIONS,
              };
              process.env.BUILDX_BUILDER = name;
              process.env.BUILDX_NO_DEFAULT_ATTESTATIONS = "false";
              return previous;
            }),
            () =>
              docker
                .run(["buildx", "inspect", "--bootstrap"])
                .pipe(Effect.andThen(effect)),
            (previous) =>
              Effect.sync(() => {
                if (previous.builder === undefined)
                  delete process.env.BUILDX_BUILDER;
                else process.env.BUILDX_BUILDER = previous.builder;
                if (previous.attestations === undefined)
                  delete process.env.BUILDX_NO_DEFAULT_ATTESTATIONS;
                else
                  process.env.BUILDX_NO_DEFAULT_ATTESTATIONS =
                    previous.attestations;
              }),
          ),
        () => docker.run(["buildx", "rm", "--force", name]).pipe(Effect.orDie),
      );
    });

const decodeBuild = Schema.Struct({
  ref: Schema.String,
  status: Schema.String,
}).pipe(Schema.fromJsonString, Schema.decodeEffect);

export const buildHistory = Effect.gen(function* () {
  const docker = yield* Docker;
  const history = yield* docker.run([
    "buildx",
    "history",
    "ls",
    "--format",
    "json",
  ]);
  return yield* Effect.forEach(
    history.stdout.split("\n").filter(Boolean),
    (line) => decodeBuild(line),
  );
});
