import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Composition root. Implement the app per PROMPT.md: define your resources
 * under src/ and return the required stack outputs here.
 */
export default Alchemy.Stack(
  "pastebin",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // TODO: implement per PROMPT.md — deploy a Worker + D1 and return its URL.
    return { url: "" };
  }),
);
