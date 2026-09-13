import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { open as openSession } from "../../Alchemist/Session.ts";
import * as Discovery from "../../Dashboard/Discovery.ts";
import { launchDashboard } from "../../Dashboard/Launch.ts";
import * as CliKit from "../CliKit/index.ts";
import {
  configPath,
  envFile,
  optionalConfig,
  profile,
  resolveStackArgs,
  stage,
} from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const port = Flag.integer("port").pipe(
  Flag.withDescription(
    "Port to serve the dashboard on. Defaults to a stable per-project port; 0 picks a random free port",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const noOpen = Flag.boolean("no-open").pipe(
  Flag.withDescription("Do not open the dashboard in the browser"),
  Flag.withDefault(false),
);

interface DashboardArgs {
  readonly main: string;
  readonly stage: string;
  readonly envFile: Option.Option<string>;
  readonly profile?: string;
  readonly port?: number;
  readonly noOpen: boolean;
}

const runDashboard = Effect.fn(function* (args: DashboardArgs) {
  const target = {
    entrypoint: args.main,
    stage: args.stage,
    profile: args.profile,
    envFile: Option.getOrUndefined(args.envFile),
  };
  // A dashboard for this project is already serving: point at it instead
  // of fighting over the advertisement — deploys in this project already
  // stream to it, and the SPA keeps exactly one tab alive per origin.
  const existing = yield* Discovery.discover().pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (existing !== undefined) {
    yield* CliKit.accessors.output.info(
      `alchemy dashboard is already running for ${existing.stack}/${existing.stage} at ${existing.url}`,
    );
    if (!args.noOpen) {
      yield* CliKit.openUrl(existing.url).pipe(Effect.catch(() => Effect.void));
    }
    return;
  }
  let port = args.port;
  if (port === undefined) {
    // Stable per-project port (see Discovery.stablePort) so the browser
    // tab from a previous run reconnects to the same origin; random when
    // something foreign already owns it.
    const { stack } = yield* openSession(target);
    const stable = Discovery.stablePort(stack.name);
    const probe = yield* Discovery.probePort(stable, stack.name);
    port = probe.kind === "free" ? stable : 0;
  }
  yield* launchDashboard({
    target,
    port,
    open: !args.noOpen,
  });
});

/**
 * `alchemy dashboard [config]` — serve the local web dashboard for a
 * stack: its resource graph from the state store, annotated with the
 * current plan (create/update/replace/delete) when it can be computed,
 * live apply progress from every `deploy`/`destroy` run in the project,
 * and the deployment history the store keeps. Requires the optional
 * `@alchemy.run/dashboard` peer dependency; fails with install
 * instructions when it is missing.
 */
export const dashboardCommand = Command.make(
  "dashboard",
  {
    config: optionalConfig,
    configPath,
    envFile,
    stage,
    profile,
    port,
    noOpen,
  },
  (args) =>
    resolveStackArgs("live")(args).pipe(
      Effect.flatMap(
        instrumentCommand("dashboard", (a: DashboardArgs) => ({
          "alchemy.main": a.main,
          "alchemy.stage": a.stage,
          "alchemy.profile": a.profile,
          "alchemy.dashboard.port": a.port,
        }))(runDashboard),
      ),
    ),
).pipe(
  Command.withDescription("Serve the web dashboard for a stack"),
  Command.withExamples([
    { command: "alchemy dashboard" },
    { command: "alchemy dashboard --stage prod --no-open" },
  ]),
);
