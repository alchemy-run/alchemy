import * as AI from "@alchemy.run/ai";
import * as Layer from "effect/Layer";
import { ENGINE } from "./Tool.ts";

/** OpenCode's own `bash` as `AI.Bash`. OpenCode runs it in the session's sandbox. */
export const BashLive = AI.Bash.native(ENGINE, "bash");
/** OpenCode's own `read` as `AI.Read`. */
export const ReadLive = AI.Read.native(ENGINE, "read");
/** OpenCode's own `edit` as `AI.Edit`. */
export const EditLive = AI.Edit.native(ENGINE, "edit");
/** OpenCode's own `write` as `AI.Write`. */
export const WriteLive = AI.Write.native(ENGINE, "write");
/** OpenCode's own `grep` as `AI.Grep`. */
export const GrepLive = AI.Grep.native(ENGINE, "grep");
/** OpenCode's own `glob` as `AI.Glob`. */
export const GlobLive = AI.Glob.native(ENGINE, "glob");

/**
 * A Layer for every tool in `AI.CodingTools`, each OpenCode's own. Their
 * descriptions and schemas are OpenCode's.
 */
export const CodingToolsLive = Layer.mergeAll(
  BashLive,
  ReadLive,
  EditLive,
  WriteLive,
  GrepLive,
  GlobLive,
);
