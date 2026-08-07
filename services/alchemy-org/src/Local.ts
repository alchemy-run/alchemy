/**
 * The coder over LOCAL physics — the laptop provide-list: DriverMemory
 * fibers with sqlite durability (threads, transcripts, refs), and the
 * read/run/write toolbox on the process's own FileSystem/shell over
 * ONE fixed workspace.
 */
import * as Layer from "effect/Layer";
import * as Workspace from "alchemy/Workspace";
import { Coder, CoderLive } from "./Coder.ts";
import { CoderChats, DriverLocal } from "./services/Driver.ts";
import {
  ReadToolsLocal,
  RunToolsLocal,
  WriteToolsLocal,
} from "./tools/LocalToolbox.ts";

export { Coder };

/**
 * The workspace the coder works IN — the repository the operator
 * points it at (`CODER_WORKSPACE`), defaulting to this repository's
 * root (the coder then works on alchemy itself). One fixed
 * containment root: file tools cannot reach outside it.
 */
const workspaceRoot =
  process.env.CODER_WORKSPACE ?? `${process.cwd()}/../..`;

const WorkspaceLive = Workspace.fixed(workspaceRoot);

export const Local = CoderLive.pipe(
  Layer.provide([ReadToolsLocal, RunToolsLocal, WriteToolsLocal]),
  Layer.provide(WorkspaceLive),
  // provideMERGE: the HTTP edge (Server.ts) consumes AgentGateway for
  // the run-socket `/attach` door, so the driver bundle must be exported
  Layer.provideMerge(DriverLocal),
  // the chat projection (same const the driver bundle observes into)
  // — consumed by the HTTP edge for the transcript
  Layer.provideMerge(CoderChats),
  Layer.orDie,
);
