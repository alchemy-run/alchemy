/**
 * RivetKit's JSON encoding of action arguments and results: plain JSON, with
 * byte arrays as `["$Uint8Array", base64]` and bigints as `["$BigInt", text]`.
 * An array that already starts with a `$` string is escaped with one more `$`.
 *
 * @internal
 */

const BIGINT = "$BigInt";
const UINT8_ARRAY = "$Uint8Array";
const ARRAY_BUFFER = "$ArrayBuffer";

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Base64url without padding, as the gateway reads `rvt-input`. */
export const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

/** Serialize a value as RivetKit's JSON. */
export const stringifyCompat = (value: unknown): string =>
  JSON.stringify(value, (_key, member: unknown) => {
    if (typeof member === "bigint") return [BIGINT, member.toString()];
    if (member instanceof Uint8Array) return [UINT8_ARRAY, toBase64(member)];
    if (
      Array.isArray(member) &&
      member.length === 2 &&
      typeof member[0] === "string" &&
      member[0].startsWith("$")
    ) {
      return [`$${member[0]}`, member[1]];
    }
    return member;
  });

const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && value[0].startsWith("$")) {
      const [tag, payload] = value as [string, unknown];
      if (tag === BIGINT && typeof payload === "string") return BigInt(payload);
      if ((tag === UINT8_ARRAY || tag === ARRAY_BUFFER) && typeof payload === "string") {
        return fromBase64(payload);
      }
      if (tag.startsWith("$$")) return [tag.slice(1), revive(payload)];
    }
    return value.map(revive);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, revive(member)]));
  }
  return value;
};

/** Parse RivetKit's JSON. */
export const parseCompat = (text: string): unknown => revive(JSON.parse(text));
