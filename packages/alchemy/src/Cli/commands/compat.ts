import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

export const compatibilityCommands = {
  login: "alchemy profile",
  tail: "alchemy logs --follow",
  sync: "alchemy drift --repair",
  aws: "alchemy provider aws",
  cloudflare: "alchemy provider cloudflare",
} as const;

export type CompatibilityCommand = keyof typeof compatibilityCommands;

export const compatibilityCommand = (name: CompatibilityCommand) =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      yield* Console.log(`The \`alchemy ${name}\` command has been moved.`);
      yield* Console.log(`Run \`${compatibilityCommands[name]}\` instead.`);
    }),
  ).pipe(Command.unlisted);
