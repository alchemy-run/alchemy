import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { BuildProvider } from "./Build.ts";
import { CommandExecutorLive } from "./Command.ts";
import { DevProvider } from "./Dev.ts";
import { ExecProvider } from "./Exec.ts";

const Noop = <TKind extends string>(kind: TKind) =>
  Provider.succeed(Resource<Resource<TKind>>(kind), {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.succeed({}),
    delete: () => Effect.void,
  });

const legacy = () =>
  Layer.merge(
    Noop("Build.Command"),
    Noop("Build.DevServer"),
  ) as Layer.Layer<never>;

export const providers = () =>
  Layer.mergeAll(BuildProvider(), DevProvider(), ExecProvider(), legacy()).pipe(
    Layer.provide(CommandExecutorLive()),
  );
