import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { KubernetesApiError } from "./client.ts";

/**
 * A key was supplied in both `stringData` and `binaryData`. Kubernetes
 * resolves this silently (`stringData` wins), which hides mistakes; alchemy
 * refuses instead.
 */
export class SecretDataKeyConflict extends Data.TaggedError("Kubernetes.SecretDataKeyConflict")<{
  keys: string[];
}> {
  override get message(): string {
    return `Kubernetes.Secret keys must be unique across stringData and binaryData; duplicated: ${this.keys.join(", ")}`;
  }
}

/**
 * A `binaryData` value is not standard base64. The API server would reject
 * it, and some versions quote the surrounding request body (other Secret
 * values) in that rejection, so alchemy refuses before sending it. Only the
 * keys are reported, never the values.
 */
export class SecretDataNotBase64 extends Data.TaggedError("Kubernetes.SecretDataNotBase64")<{
  keys: string[];
}> {
  override get message(): string {
    return `Kubernetes.Secret binaryData values must be standard (padded) base64; invalid: ${this.keys.join(", ")}`;
  }
}

/**
 * The live Secret has a controller owner (e.g. an External Secrets
 * `ExternalSecret` or a `SealedSecret`). A forced server-side apply would
 * take its fields over and the controller would write them back on its next
 * sync, so alchemy refuses rather than fight it.
 */
export class SecretControlledByOwner extends Data.TaggedError(
  "Kubernetes.SecretControlledByOwner",
)<{
  namespace: string;
  name: string;
  owner: OwnerReference;
}> {
  override get message(): string {
    return `Kubernetes.Secret ${this.namespace}/${this.name} is controlled by ${this.owner.apiVersion}/${this.owner.kind} ${this.owner.name}; release it from that controller or choose another name`;
  }
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid?: string;
  controller?: boolean;
}

export interface SecretData {
  stringData?: Record<string, Redacted.Redacted<string>>;
  binaryData?: Record<string, Redacted.Redacted<string>>;
}

// Go's StdEncoding, which the API server decodes `data` with: padded, and
// tolerant of CR/LF line wrapping.
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isBase64 = (value: string) => base64Pattern.test(value.replace(/[\r\n]/g, ""));

/**
 * Merge `stringData` (UTF-8, base64-encoded here) and `binaryData` (already
 * base64) into the wire-level `data` map. Values are unwrapped only at this
 * edge, immediately before the Kubernetes API request.
 */
export const encodeSecretData = ({
  stringData = {},
  binaryData = {},
}: SecretData): Effect.Effect<
  Record<string, string>,
  SecretDataKeyConflict | SecretDataNotBase64
> =>
  Effect.gen(function* () {
    const conflicts = Object.keys(stringData).filter((key) => Object.hasOwn(binaryData, key));
    if (conflicts.length > 0) {
      return yield* new SecretDataKeyConflict({ keys: conflicts });
    }
    const invalid = yield* Effect.sync(() =>
      Object.entries(binaryData)
        .filter(([, value]) => !isBase64(Redacted.value(value)))
        .map(([key]) => key),
    );
    if (invalid.length > 0) {
      return yield* new SecretDataNotBase64({ keys: invalid });
    }
    return yield* Effect.sync(() => ({
      ...Object.fromEntries(
        Object.entries(stringData).map(([key, value]) => [
          key,
          Buffer.from(Redacted.value(value), "utf8").toString("base64"),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(binaryData).map(([key, value]) => [key, Redacted.value(value)]),
      ),
    }));
  });

const mapStrings = (value: unknown, f: (text: string) => string): unknown => {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, mapStrings(child, f)]),
    );
  }
  return value;
};

/**
 * Replace every Secret value in `text`, as plaintext or base64, with
 * `<redacted>`. Over-redacting a very short value garbles the message but
 * never leaks it.
 */
export const scrubSecretValues = (
  text: string,
  { stringData = {}, binaryData = {} }: SecretData,
): string => {
  const needles = [
    ...new Set([
      ...Object.values(stringData).flatMap((value) => {
        const plain = Redacted.value(value);
        return [plain, Buffer.from(plain, "utf8").toString("base64")];
      }),
      ...Object.values(binaryData).flatMap((value) => {
        const encoded = Redacted.value(value);
        return [encoded, encoded.replace(/[\r\n]/g, "")];
      }),
    ]),
  ]
    .filter((needle) => needle.length > 0)
    // Longest first, so a value that contains another is replaced whole.
    .sort((left, right) => right.length - left.length);
  if (needles.length === 0) return text;
  const scrub = (value: string) =>
    needles.reduce((out, needle) => out.replaceAll(needle, "<redacted>"), value);
  // Status bodies are JSON, whose escaping (`\"`, `\\`, Go's `&` for
  // `&`) can split a value, so scrub the decoded strings when it parses.
  try {
    return JSON.stringify(mapStrings(JSON.parse(text), scrub));
  } catch {
    return scrub(text);
  }
};

/**
 * Re-fail an API error with the Secret's values scrubbed from its body. The
 * body can quote the request (an admission webhook denial, for one), and
 * the error message carries the body.
 */
export const scrubApiError = (
  error: KubernetesApiError,
  data: SecretData,
): Effect.Effect<never, KubernetesApiError> =>
  Effect.sync(() => scrubSecretValues(error.body, data)).pipe(
    Effect.flatMap((body) =>
      Effect.fail(
        new KubernetesApiError({
          method: error.method,
          path: error.path,
          statusCode: error.statusCode,
          body,
        }),
      ),
    ),
  );

/**
 * Fail when the observed Secret (`undefined` if it does not exist yet) has a
 * controller owner. Plain owner references only tie garbage collection to a
 * parent and do not block.
 */
export const ensureNotControlled = (
  ref: { namespace: string; name: string },
  observed: unknown,
): Effect.Effect<void, SecretControlledByOwner> => {
  const owners =
    (observed as { metadata?: { ownerReferences?: OwnerReference[] } } | undefined)?.metadata
      ?.ownerReferences ?? [];
  const owner = owners.find((candidate) => candidate.controller === true);
  return owner ? Effect.fail(new SecretControlledByOwner({ ...ref, owner })) : Effect.void;
};
