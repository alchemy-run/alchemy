import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Reports the runtime it runs on. Shares its logical id with the other runtime fixture. */
export default class NodeService extends Docker.Service<NodeService>()(
  "DockerRuntimeService",
  {
    main: import.meta.filename,
    runtime: "node24",
    port: 3000,
    ports: [{ internal: 3000 }],
    replicas: 1,
  },
  Effect.succeed({
    fetch: HttpServerResponse.json({
      bun: process.versions.bun ?? null,
      node: process.versions.node,
    }),
  }),
) {}
