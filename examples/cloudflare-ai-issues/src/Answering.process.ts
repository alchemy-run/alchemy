import * as AI from "@alchemy.run/ai";

/**
 * How an answer on an issue reads. A session reads it only when it is about
 * to write one, so it costs nothing until then.
 */
export class Answering extends (AI.Process<Answering>()("Answering", {
  description: "How to write an answer on an issue. Follow it before you post one.",
})`
  Write the answer in Markdown and keep it under two hundred words.
  Start with the answer itself, in one sentence.
  Name each file you read as a path in backticks, with a line number where it helps.
  Say what you did not check. Never promise a fix or a date.
`) {}
