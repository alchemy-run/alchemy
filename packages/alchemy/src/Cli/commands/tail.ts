import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Command from "effect/unstable/cli/Command";

import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import * as Tail from "../../Tail.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import {
  envFile,
  importStack,
  instrumentCommand,
  parseResourceFilter,
  profile,
  resourceFilter,
  script,
  stage,
} from "./_shared.ts";

export const tailCommand = Command.make(
  "tail",
  {
    main: script,
    envFile,
    stage,
    profile,
    filter: resourceFilter,
  },
  instrumentCommand(
    "tail",
    (a: { main: string; stage: string; profile: string }) => ({
      "alchemy.stage": a.stage,
      "alchemy.profile": a.profile,
      "alchemy.main": a.main,
    }),
  )(
    Effect.fn(function* ({ main, stage, envFile, profile, filter }) {
      const stackEffect = yield* importStack(main);

      const services = Layer.mergeAll(
        ConfigProvider.layer(
          withProfileOverride(yield* loadConfigProvider(envFile), profile),
        ),
        Layer.succeed(AuthProviders, {}),
        Layer.succeed(Stage, stage),
        Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        State.localState(),
      );

      yield* Effect.gen(function* () {
        const stack = yield* stackEffect;

        yield* Effect.gen(function* () {
          const filterSet = parseResourceFilter(filter);
          const availableIds = [
            ...new Set(Object.values(stack.resources).map((r) => r.LogicalId)),
          ].sort();

          if (filterSet) {
            for (const id of filterSet) {
              if (!availableIds.includes(id)) {
                return yield* Effect.die(
                  new Error(
                    `Unknown resource '${id}' in --filter. Available: ${availableIds.join(", ") || "(none)"}`,
                  ),
                );
              }
            }
          }

          const tailable = yield* Tail.discoverTailable(stack, {
            filter: filterSet,
          });

          if (tailable.length === 0) {
            if (filterSet) {
              yield* Console.log(
                "No tailable resources match --filter (deploy first, or selected resources may not support tail).",
              );
            } else {
              yield* Console.log(
                "No tailable resources found. Deploy first, then run tail.",
              );
            }
            return;
          }

          yield* Console.log(
            `Tailing: ${tailable.map((t) => t.logicalId).join(", ")}`,
          );

          yield* Tail.tailAll(tailable);
        }).pipe(Effect.provide(stack.services));
      }).pipe(Effect.provide(services));
    }),
  ),
);
