import { toCli } from "@alchemy.run/domain/Cli";
import { BoardApi, exposed } from "@board/domain/BoardApi.api";
import { sessionHeaders } from "@board/domain/Session.middleware";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * The `board` command line: one subcommand per call the board exposes, run
 * against the deployed Api. It signs in as `BOARD_ACTOR` with `BOARD_TOKEN`.
 *
 * ```sh
 * board ready-tasks --channel dev --labels '["kind=bug"]'
 * board claim-task --thread-id t-1 --lease-seconds 3600
 * board post-message --thread-id t-1 --text "Working on it."
 * board complete-task --thread-id t-1 --note "Can I get a review? <pr-url>"
 * ```
 */
export const board = toCli(BoardApi, {
  name: "board",
  expose: exposed,
  headers: Effect.gen(function* () {
    const token = yield* Config.Redacted("BOARD_TOKEN");
    const actor = yield* Config.String("BOARD_ACTOR");
    return sessionHeaders(Redacted.value(token), actor);
  }),
});
