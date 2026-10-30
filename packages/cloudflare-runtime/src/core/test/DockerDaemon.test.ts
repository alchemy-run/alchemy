import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Docker, DockerLive } from "../Docker.ts";

const docker = (...args: string[]) =>
  Effect.sync(() => execFileSync(process.env.DOCKER_BIN ?? "docker", args, { encoding: "utf8" }));

it.live(
  "pulls an unprepared image again after a failed container create",
  () => {
    // Unresolvable registry: the first on-demand pull must fail.
    const image = "alchemy-test.invalid/missing:retry";
    const name = `alchemy-pull-retry-${crypto.randomUUID()}`;
    return Effect.gen(function* () {
      const config = yield* (yield* Docker).getWorkerdDockerConfiguration;
      const create = Effect.promise(() =>
        fetch(`http://${config.localDocker!.socketPath}/containers/create?name=${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ Image: image, Env: [] }),
        }).then(async (response) => ({ status: response.status, body: await response.text() })),
      );

      const failed = yield* create;
      expect(failed.status).toBe(500);

      // Once the image exists, the same create must succeed: the failed pull
      // was not cached.
      yield* docker("pull", "alpine:3.21");
      yield* docker("tag", "alpine:3.21", image);
      const created = yield* create;
      expect(created.status).toBe(201);
    }).pipe(
      Effect.ensuring(
        Effect.ignore(docker("rm", "--force", name)).pipe(
          Effect.andThen(Effect.ignore(docker("rmi", image))),
        ),
      ),
      Effect.provide(
        Layer.provide(
          DockerLive,
          Layer.mergeAll(
            NodeServices.layer,
            SecureRandom.layerWebCrypto,
            SecureRandom.layerWebCrypto,
          ),
        ),
      ),
    );
  },
  60_000,
);
