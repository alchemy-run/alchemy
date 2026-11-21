import * as AI from "@alchemy.run/ai";
import * as Layer from "effect/Layer";
import { ENGINE } from "./Tool.ts";

/** OpenCode's own `shell` as `AI.Bash`. OpenCode runs it in the session's sandbox. */
export const Bash = AI.Bash.native(ENGINE, "shell");
/** OpenCode's own `read` as `AI.Read`. */
export const Read = AI.Read.native(ENGINE, "read");
/** OpenCode's own `edit` as `AI.Edit`. */
export const Edit = AI.Edit.native(ENGINE, "edit");
/** OpenCode's own `write` as `AI.Write`. */
export const Write = AI.Write.native(ENGINE, "write");
/** OpenCode's own `grep` as `AI.Grep`. */
export const Grep = AI.Grep.native(ENGINE, "grep");
/** OpenCode's own `glob` as `AI.Glob`. */
export const Glob = AI.Glob.native(ENGINE, "glob");

/**
 * A Layer for every tool in `AI.CodingTools`, each OpenCode's own. Their
 * descriptions and schemas are OpenCode's.
 */
export const CodingTools = Layer.mergeAll(Bash, Read, Edit, Write, Grep, Glob);
