import * as Forgejo from "@/Forgejo/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { fixture } from "./live.ts";

// macOS caches the new quick-tunnel hostname as NXDOMAIN. Deployment requests
// use the same real instance over loopback; deployed hosts use the profile URL.
export const runtimeRequests: Array<{ method: string; path: string }> = [];
export const runtimeTransport = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const config = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const log = yield* fs.readFileString(
      path.resolve("../../.alchemy/forgejo/runtime-tunnel.log"),
    );
    const origin = log.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/)?.[0];
    if (!origin) return yield* Effect.die("Owned Forgejo tunnel has no URL");
    return HttpClient.mapRequestEffect(client, (request) =>
      Effect.sync(() => {
        runtimeRequests.push({
          method: request.method,
          path: new URL(request.url).pathname,
        });
        return request.url.startsWith(`${origin}/api/v1/`)
          ? HttpClientRequest.setUrl(
              request,
              request.url.replace(/^https:\/\/[^/]+/, config.baseUrl),
            )
          : request;
      }),
    );
  }),
).pipe(Layer.orDie);
export const runtimeProviders = Forgejo.providers().pipe(
  Layer.provide(runtimeTransport),
  Layer.orDie,
);
