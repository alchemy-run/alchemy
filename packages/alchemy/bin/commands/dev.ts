import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { envFile, main, stage } from "./_shared.ts";

export const devCommand = Command.make(
  "dev",
  {
    main,
    envFile,
    stage,
  },
  ({ envFile, main, stage }) =>
    Effect.gen(function* () {
      const cmd = ChildProcess.make("bun", ["--hot", main], {
        env: {
          ALCHEMY_PHASE: "dev",
        },
      });

      const proc = yield* cmd;

      proc.stdout;
      proc.stderr;
      proc.all;
    }),
);
