/**
 * Discord signs interaction and webhook-event requests with the
 * application's Ed25519 key: `X-Signature-Ed25519` is the hex signature of
 * `X-Signature-Timestamp + body`
 * (https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint-validating-security-request-headers).
 * Uses WebCrypto, which Workers, Node 20+ and Bun all have.
 */
import * as Effect from "effect/Effect";

const fromHex = (hex: string) => {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

/** Whether `request`'s signature headers verify `body` under `publicKey` (hex). */
export const verifyDiscordSignature = (
  publicKey: string,
  request: Request,
  body: string,
): Effect.Effect<boolean> => {
  const signature = fromHex(request.headers.get("x-signature-ed25519") ?? "");
  const timestamp = request.headers.get("x-signature-timestamp");
  const key = fromHex(publicKey);
  if (signature === undefined || signature.length !== 64 || !timestamp || key === undefined) {
    return Effect.succeed(false);
  }
  return Effect.tryPromise(async () => {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return crypto.subtle.verify(
      { name: "Ed25519" },
      imported,
      signature,
      new TextEncoder().encode(timestamp + body),
    );
  }).pipe(Effect.orElseSucceed(() => false));
};
