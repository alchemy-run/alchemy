import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const region = "us-east-1" as const;

/** One Prisma project (no database) shared by the API and the website. */
export const Project = Prisma.Project("Project", {
  createDatabase: false,
  region,
});

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A basic Effect HTTP API on Prisma Compute, called by the solid-yield SPA. */
export default class Api extends Prisma.Compute<Api>()(
  "Api",
  Effect.gen(function* () {
    const project = yield* Project;
    return {
      project,
      regionId: region,
      main: import.meta.filename,
      port: 3000,
      healthCheck: { path: "/api/greeting" },
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: cors });
        }
        if (path === "/api/greeting") {
          return yield* HttpServerResponse.json(
            { message: "Hello from the Prisma API!", platform: "Prisma" },
            { headers: cors },
          );
        }
        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404, headers: cors },
        );
      }).pipe(Effect.orDie),
    };
  }),
) {}
