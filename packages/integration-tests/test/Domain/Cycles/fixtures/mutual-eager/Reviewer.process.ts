import * as AI from "@alchemy.run/ai";
import { Author } from "./Author.process.ts";

/** Reviews a draft, and hands it back to an Author when it needs work. */
export class Reviewer extends AI.Process<Reviewer>()("Reviewer", {}) {}

export const ReviewerLive = Reviewer.toLayer({ description: "Review a draft." })`
  Review the draft. When it needs work, start an ${Author} to rewrite it.
`;
