import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { distilledFromSource } from "../distilled-source.ts";
import { app } from "./app.ts";
import { LOCATION, TestWorkflows } from "./host.ts";

/** A plain Azure Function that runs the test workflows on TestWorkflows, over HTTP. */
export default class WorkflowCaller extends Azure.Functions.Function<WorkflowCaller>()(
  "WorkflowCaller",
  {
    main: import.meta.url,
    location: LOCATION,
    build: { input: { plugins: [distilledFromSource] } },
  },
  app.pipe(Effect.provide(Azure.Functions.DurableEngine(TestWorkflows))),
) {}
