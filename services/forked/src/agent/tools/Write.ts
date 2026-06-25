import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { ReadTracker } from "../ReadTracker.ts";
import { Sandbox } from "../Sandbox.ts";

export const filePath = AI.Parameter("filePath", S.String)`
The path to the file to write, relative to the workspace root.`;

export const content = AI.Parameter("content", S.String)`
The content to write to the file.`;

export class Write extends AI.Tool<Write>()("write")`
Writes a file to the sandbox filesystem.

Usage:
- This tool will overwrite the existing file at ${filePath} if there is one.
- If this is an existing file, you MUST use the read tool first to read the
  file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files
  unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only
  create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to
  files unless asked.
- Provide the full ${content} of the file; partial writes are not supported.` {}

export const WriteLive = Layer.effect(
  Write,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const tracker = yield* ReadTracker;

    return Effect.fn("write")(function* (params) {
      const { filePath, content } = params as {
        filePath: string;
        content: string;
      };

      // Read-before-write: overwriting an existing file requires reading it
      // first, mirroring OpenCode's safety rule.
      const exists = yield* sandbox
        .readFile(filePath)
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (exists && !(yield* tracker.hasRead(filePath))) {
        return {
          error: `File ${filePath} already exists. Use the read tool to read it before overwriting.`,
        };
      }

      yield* sandbox.writeFile(filePath, content);
      yield* tracker.markRead(filePath);
      return { path: filePath, bytes: content.length };
    });
  }),
);
