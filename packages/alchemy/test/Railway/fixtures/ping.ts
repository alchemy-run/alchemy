import { Function } from "@/Railway/Function.ts";
import { Project } from "@/Railway/Project.ts";
import { SUITE_PROJECT_NAME } from "../suiteProjectName.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const Site = Project("Suite", { name: SUITE_PROJECT_NAME });

/**
 * Effect-native Railway.Function: bundled into a single file and
 * deployed as a canvas Function. No Docker. No registry.
 */
export default class Ping extends Function<Ping>()(
  "Ping",
  {
    project: Site,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
