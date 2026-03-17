import * as Effect from "effect/Effect";

type Input = ArrayBuffer | Uint8Array | string;

export const sha256 = (input: Input) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  });

export const sha256Object = (input: object) =>
  sha256(JSON.stringify(stableValue(input)));

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

const toArrayBuffer = (input: Input) => {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
};
