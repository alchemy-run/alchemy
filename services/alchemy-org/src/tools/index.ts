/**
 * The bot's tools — one file per tool: the contract (an `AI.Tool`
 * term) co-located with its implementation Layer(s), the same
 * convention as alchemy's resources. Physics that is missing fails
 * MODEL-VISIBLY (a tool result the agent reacts to), never as a
 * defect.
 */
export * from "./Bash.ts";
export * from "./Glob.ts";
export * from "./Grep.ts";
export * from "./ListDirectory.ts";
export * from "./ReadDiff.ts";
export * from "./ReadIssue.ts";
export * from "./ReadFile.ts";
export * from "./ReadOutput.ts";
