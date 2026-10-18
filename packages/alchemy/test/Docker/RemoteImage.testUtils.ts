import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Docker from "@/Docker";
import { findAvailablePort } from "./Runtime.ts";

export const localRegistry = Effect.fn(function* () {
  const docker = yield* Docker.Docker;
  const client = yield* HttpClient.HttpClient;
  const port = yield* findAvailablePort();
  const host = `localhost:${port}`;
  const name = `alchemy-test-remote-image-registry-${port}`;
  yield* Effect.addFinalizer(() => docker.run(["rm", "-f", name]).pipe(Effect.ignore));
  yield* docker.run(["run", "-d", "--name", name, "-p", `${port}:5000`, "registry:2"]);
  yield* client
    .get(`http://${host}/v2/`)
    .pipe(Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 7 }));

  const credentials = {
    server: host,
    username: "alchemy",
    password: Redacted.make("ignored-by-insecure-registry"),
  };

  const manifestDigest = (repository: string, tag: string) =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.head(`http://${host}/v2/${repository}/manifests/${tag}`).pipe(
          HttpClientRequest.setHeader(
            "accept",
            [
              "application/vnd.oci.image.index.v1+json",
              "application/vnd.oci.image.manifest.v1+json",
              "application/vnd.docker.distribution.manifest.list.v2+json",
              "application/vnd.docker.distribution.manifest.v2+json",
            ].join(", "),
          ),
        ),
      );
      if (response.status !== 200) {
        return yield* Effect.fail(
          new Error(`Expected a registry manifest, got ${response.status}`),
        );
      }
      return response.headers["docker-content-digest"];
    });

  return { host, credentials, manifestDigest };
});
