import * as Effect from "effect/Effect";
import * as Command from "@effect/platform/Command";
import { CommandExecutor } from "@effect/platform/CommandExecutor";
import { loadParser } from "../util/parser.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Path from "@effect/platform/Path";

export class CommandValidator extends Context.Tag("CommandValidator")<
  CommandValidator,
  {
    validate: (command: string) => Effect.Effect<void, string, CommandExecutor>;
  }
>() {}

export const commandValidator = Layer.effect(
  CommandValidator,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const parser = yield* loadParser("tree-sitter-bash/tree-sitter-bash.wasm");
    return {
      validate: Effect.fn(function* (command: string) {
        const tree = parser.parse(command);
        if (!tree) {
          return yield* Effect.fail("Failed to parse command");
        }
        for (const node of tree.rootNode.descendantsOfType("command")) {
          if (!node) continue;
          const command = [];
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child) continue;
            if (
              child.type !== "command_name" &&
              child.type !== "word" &&
              child.type !== "string" &&
              child.type !== "raw_string" &&
              child.type !== "concatenation"
            ) {
              continue;
            }
            command.push(child.text);
          }

          // not an exhaustive list, but covers most common cases
          if (
            [
              "cd",
              "rm",
              "cp",
              "mv",
              "mkdir",
              "touch",
              "chmod",
              "chown",
            ].includes(command[0])
          ) {
            for (const arg of command.slice(1)) {
              if (
                arg.startsWith("-") ||
                (command[0] === "chmod" && arg.startsWith("+"))
              )
                continue;
              const resolved = yield* Command.string(
                Command.make("realpath", arg).pipe(Command.runInShell(true)),
              ).pipe(
                Effect.map((x) => x.trim()),
                Effect.catchAll(() => Effect.void),
              );

              if (resolved) {
                const cwd = process.cwd();
                const relative = path.relative(cwd, resolved);
                if (relative.startsWith("..")) {
                  return yield* Effect.fail(
                    `Cannot ${command[0]} file: ${arg} is outside the current working directory: ${cwd}`,
                  );
                }
              }
            }
          }
        }
      }),
    };
  }),
);
