import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { GreetingApi } from "./spec.ts";

export const region = "us-east-1" as const;

/** One Prisma project (no database) shared by the API and the website. */
export const Project = Prisma.Project("Project", {
  createDatabase: false,
  region,
});

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
    const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
      handlers.handle("greeting", () =>
        Effect.succeed({ message: "Hello from the Prisma API!", platform: "Prisma" }),
      ),
    );

    return {
      fetch: HttpApiBuilder.layer(GreetingApi).pipe(
        Layer.provide(greeting),
        // The SPA is served from another origin.
        Layer.provide(HttpRouter.cors()),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }),
) {}
