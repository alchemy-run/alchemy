import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/** Everything that reaches the board: GitHub's events, and a session's label. */
export class BoardApi extends Domain.Api("BoardApi", { model: Board }) {}
