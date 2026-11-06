import * as Docker from "@alchemy.run/docker";
import * as Portless from "@alchemy.run/portless";
import { expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

// The Docker example in the docs, type-checked and never run: a container reaches a service by
// its name through `extraHosts`, and trusts the proxy's CA through a mounted file.
export const containerExample = Effect.gen(function* () {
  const proxy = yield* Portless.Proxy("Proxy", { domain: "myapp" });
  const api = yield* Portless.Dev("Api", { proxy, command: "node --watch server.ts" });

  return yield* Docker.Container("worker", {
    image: "ghcr.io/acme/worker:latest",
    // The service's name resolves to the host, where the proxy listens.
    extraHosts: [`${api.hostname}:host-gateway`],
    volumes: [
      {
        hostPath: proxy.certificateAuthority,
        containerPath: "/etc/portless/ca.pem",
        readOnly: true,
      },
    ],
    environment: {
      NODE_EXTRA_CA_CERTS: "/etc/portless/ca.pem",
      API_URL: api.origin,
    },
    start: true,
  });
});

test(
  "the Docker example in the docs type-checks",
  () => {
    expect(containerExample).toBeDefined();
  },
  { tags: ["unit"] },
);
