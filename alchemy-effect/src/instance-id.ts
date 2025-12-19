import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

/** A 16-byte (128-bit) random hex-encoded string representing an physical instance of a logical resource */
export class InstanceId extends Context.Tag("instance-id")<
  InstanceId,
  string
>() {}

/**
 * @returns Hex-encoded instance ID (16 random bytes)
 */
export const generateInstanceId = () =>
  Effect.sync(() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
