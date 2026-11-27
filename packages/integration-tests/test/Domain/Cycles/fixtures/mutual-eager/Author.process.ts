import * as AI from "@alchemy.run/ai";
import { Reviewer } from "./Reviewer.process.ts";

/** Writes a draft, and hands it to a Reviewer. */
export class Author extends AI.Process<Author>()("Author", {}) {}

export const AuthorLive = Author.toLayer({ description: "Write a draft." })`
  Write the draft, then start a ${Reviewer} to review it.
`;
