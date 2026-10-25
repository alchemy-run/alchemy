import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { JobApiLive } from "./JobApiLive.ts";
import { JobStorageTable } from "./JobStorage.ts";

/**
 * The Job API on Azure Functions (Flex Consumption). `HttpRouter.toHttpEffect`
 * turns the `HttpApi` layer into the Function's `fetch`. Building it runs
 * the handlers' init once, which binds the `Jobs` table to the Function.
 */
export default class JobFunction extends Azure.Functions.Function<JobFunction>()(
  "JobFunction",
  { main: import.meta.url },
  HttpRouter.toHttpEffect(JobApiLive).pipe(
    Effect.map((fetch) => ({ fetch })),
    Effect.provide(Layer.mergeAll(JobStorageTable, HttpPlatform.layer, Etag.layer)),
  ),
) {}
