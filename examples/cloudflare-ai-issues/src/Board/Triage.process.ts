import * as AI from "@alchemy.run/ai";
import { IssueId } from "./Issue.id.ts";

/** The issue a session works on. */
export const issue = AI.Input("issue", IssueId);

/**
 * Answers one issue and says what kind it is. The board knows the process
 * only by this name and its input; how it is carried out is a Layer.
 */
export class Triage extends AI.Process<Triage>()("Triage", { inputs: [issue] }) {}
