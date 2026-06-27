import { OpenCodeContainer } from "@alchemy.run/harness-opencode";
import * as Config from "effect/Config";

export default OpenCodeContainer({
  main: import.meta.filename,
  anthropic: {
    apiKey: Config.redacted("ANTHROPIC_API_KEY"),
  },
  // Enable the model's extended-thinking budget so the harness emits
  // `reasoning-delta` parts — surfaced as `ReasoningDelta` events and streamed
  // chunk-by-chunk to the UI.
  reasoningVariant: "high",
});
