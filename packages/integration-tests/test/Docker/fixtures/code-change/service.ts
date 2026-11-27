import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MESSAGE } from "./message.ts";

/** Fixed host port published through the swarm ingress. */

/**
 * A service whose answer comes from a module it imports: the test copies
 * this directory, changes `message.ts` and redeploys the same `main`.
 */
export default class CodeChangeService extends Docker.Service<CodeChangeService>()(
  "DockerCodeChangeService",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ internal: 3000 }],
  },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text(MESSAGE)) }),
) {}
