import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

import * as Ai from "../../index.ts";

export const cmd = Ai.Parameter("cmd")(
  S.String.pipe(S.optional),
)`The command to run.`;

export const Bash = Ai.Tool("bash")`
Run a shell ${cmd} and return its stdout, stderr, and exit code.`(
  Effect.fn(function* ({ cmd }) {
    void cmd;
  }),
);
