import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Disk } from "./Disk.ts";
import { Exec } from "./Exec.ts";
import { makeExecClient, makeHttpAuth } from "./RuntimeAuth.ts";

/**
 * HTTP-backed implementation of the {@link Exec} binding.
 *
 * Mints a dedicated `Archil.ApiToken` for the host Function/Worker and binds
 * its value as a secret; at runtime the client calls the Archil control
 * plane over HTTPS with that token. Works on any Alchemy host (Cloudflare
 * Workers, AWS Lambda, ECS, …).
 */
export const ExecHttp = Layer.effect(
  Exec,
  Effect.gen(function* () {
    const auth = yield* makeHttpAuth;
    return Effect.fn(function* (disk: Disk) {
      const a = yield* auth;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      return makeExecClient(a, diskId, region);
    });
  }),
);
