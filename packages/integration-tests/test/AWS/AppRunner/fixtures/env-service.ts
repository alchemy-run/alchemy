import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { envValues, readEnvValues } from "../../../EnvValues.ts";

/**
 * App Runner service whose `env` holds every {@link envValues} case; `/env`
 * echoes what it reads from `process.env`.
 */
export default class EnvService extends AWS.AppRunner.Service<EnvService>()(
  "AppRunnerEnvService",
  {
    main: import.meta.filename,
    port: 3000,
    instanceConfiguration: { cpu: "256", memory: "512" },
    healthCheckConfiguration: { protocol: "HTTP", path: "/health" },
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
    env: envValues,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        if (url.pathname === "/env") {
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- asserts the raw deployed value
          return yield* HttpServerResponse.json(readEnvValues(process.env));
        }
        return yield* HttpServerResponse.json({ ok: true });
      }).pipe(Effect.orDie),
    };
  }),
) {}
