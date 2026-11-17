// The class-form example of `Prisma.Compute`'s JSDoc, with literal props.
import * as Prisma from "@alchemy.run/prisma";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class Api extends Prisma.Compute<Api>()("api") {}

export default Api.make(
  {
    project: "project-1",
    branchId: "branch-1",
    main: import.meta.filename,
    urlReadinessTimeoutSeconds: 0.2,
    timeoutSeconds: 2,
    pollIntervalMs: 1,
  },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
);
