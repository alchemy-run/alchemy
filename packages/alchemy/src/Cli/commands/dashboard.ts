import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { launchDashboard } from "../../Dashboard/Launch.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
} from "./_shared.ts";

const port = Flag.integer("port").pipe(
  Flag.withDescription("Port to serve the dashboard on"),
  Flag.withDefault(4444),
);

const noOpen = Flag.boolean("no-open").pipe(
  Flag.withDescription("Do not open the dashboard in the browser"),
  Flag.withDefault(false),
);

/**
 * `alchemy dashboard [main]` — serve a local web dashboard visualizing the
 * stack's resource graph from the state store, annotated with the current
 * plan (create/update/replace/delete) when it can be computed. Requires
 * the optional `@alchemy.run/dashboard` peer dependency; fails with
 * install instructions when it is missing.
 */
export const dashboardCommand = Command.make(
  "dashboard",
  {
    main: script,
    stage,
    envFile,
    profile,
    port,
    noOpen,
  },
  instrumentCommand(
    "dashboard",
    (a: { main: string; stage: string; port: number }) => ({
      "alchemy.main": a.main,
      "alchemy.stage": a.stage,
      "alchemy.dashboard.port": a.port,
    }),
  )(
    Effect.fn(function* ({ main, stage, envFile, profile, port, noOpen }) {
      const stackEffect = yield* importStack(main);
      yield* launchDashboard({
        stackEffect,
        stage,
        envFile,
        profile,
        port,
        open: !noOpen,
      });
    }),
  ),
);
