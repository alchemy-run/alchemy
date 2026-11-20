import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as servers from "@distilled.cloud/hetzner/servers";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { envValues, expectedEnv, getJson, readEnvValues } from "../EnvValues.ts";
import EnvService, {
  ENV_CONTAINER_PORT,
  EnvBox,
  envContainerContext,
} from "./fixtures/env-service.ts";
import { hetznerPrimaryIps } from "./limit.ts";

const { test } = Test.make({
  limit: hetznerPrimaryIps,
  providers: Hetzner.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const fetchEnv = (url: string) =>
  getJson(url, { times: 30 }).pipe(
    Effect.map((body) => readEnvValues(body as Record<string, string | undefined>)),
  );

// Both modes on one Server: the systemd `EnvironmentFile` program and a
// `context` image run with `docker run --env-file`. The deploy runs inside the
// test so the Server's primary IPs are held only under the permit.
test.provider(
  "Hetzner Services read every env value as its string (program and container)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const server = yield* EnvBox;
          const program = yield* EnvService;
          const container = yield* Hetzner.Service("EnvContainer", {
            server,
            context: envContainerContext,
            port: ENV_CONTAINER_PORT,
            env: envValues,
          });
          return {
            serverId: server.serverId,
            programUrl: program.url,
            containerUrl: container.url,
          };
        }),
      );

      const program = yield* fetchEnv(out.programUrl!);
      const container = yield* fetchEnv(out.containerUrl!);

      yield* stack.destroy();
      expect(yield* waitUntilGone(out.serverId)).toEqual("gone");

      expect({ program, container }).toEqual({
        program: expectedEnv,
        container: expectedEnv,
      });
    }).pipe(logLevel),
  {
    tags: ["provider:hetzner", "provider:hetzner:server", "provider:hetzner:service", "live"],
    timeout: 600_000,
  },
);
