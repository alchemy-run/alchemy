import * as Cloudflare from "alchemy/Cloudflare";

/**
 * A single Stream live input.
 *
 * Cloudflare mints the WebRTC publish secret when this is created — you
 * never supply or generate it. One live input is one broadcast: create a
 * second `LiveInput` for a second concurrent stream, not a second account.
 */
export const Broadcast = Cloudflare.Stream.LiveInput("Broadcast", {
  meta: { name: "alchemy-stream-webrtc-example" },
});
