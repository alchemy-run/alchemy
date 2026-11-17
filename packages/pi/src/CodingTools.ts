import type { Sandboxes } from "@alchemy.run/ai/Sandbox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools as PiCodingTools } from "@earendil-works/pi-durable/tools";
import { builtin, group, type BuiltinTool } from "./Tool.ts";

/** A coding tool works on files or a shell, so listing it requires `AI.Sandboxes`. */
const named = <Name extends string>(name: Name): BuiltinTool<Name, Sandboxes> => {
  const registration = (PiCodingTools.tools ?? []).find((tool) => tool.name === name);
  if (registration === undefined) throw new Error(`Pi's coding tools have no "${name}"`);
  return builtin(registration as ToolRegistration & { name: Name });
};

/** Read a file: text with line numbers, or an image. */
export const Read = named("read");
/** Write a whole file, creating its directories. */
export const Write = named("write");
/** Replace exact text in a file. */
export const Edit = named("edit");
/** Run a shell command in the conversation's environment. */
export const Bash = named("bash");

/**
 * Pi's coding tools: `read`, `write`, `edit` and `bash`. They run in the
 * conversation's sandbox, so a harness that lists them requires `AI.Sandboxes`.
 */
export const CodingTools = group(Read, Write, Edit, Bash);
