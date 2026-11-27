import * as Layer from "effect/Layer";
import { IssueWorkLive } from "./IssueWork.policy.ts";
import { TranscriptsLive } from "./Transcripts.projection.ts";

/** Every handler the board needs: its policy, and the projection that writes transcripts. */
export const BoardHandlers = Layer.mergeAll(IssueWorkLive, TranscriptsLive);
