import * as Cause from "effect/Cause";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { encodeRpcError } from "../Rpc.ts";

export interface WorkflowIdentity {
  readonly workflow: string;
  readonly instanceId: string;
}

const failurePrefix = "[alchemy-workflow-failure:v1]";
const terminalPrefix = "[alchemy-workflow-terminal:v1]";
const maxFailureLength = 16_384;

export type TerminalFailure = (message: string) => Promise<Error>;

export const terminalFailureMessage = (message: string): string =>
  `${terminalPrefix}${message}`;

export const callbackFailure = async <E>(
  cause: Cause.Cause<E>,
  terminalFailure: TerminalFailure,
  step: string,
  identity: WorkflowIdentity | undefined,
  isNativeTerminal?: (error: unknown) => error is Error,
): Promise<Error> => {
  const original = Cause.squash(cause);
  if (isNativeTerminal?.(original)) return original;
  if (!Cause.hasDies(cause) && !Cause.hasInterrupts(cause)) {
    try {
      const budget = { nodes: 0, seen: new Set<object>() };
      const errors = cause.reasons.map((reason) => {
        if (reason._tag !== "Fail")
          throw new TypeError("Expected an application failure");
        return encodeFailureValue(reason.error, new Set<object>(), budget);
      });
      const error = Cause.squash(cause);
      const summary =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Workflow application failure";
      const body = `${Encoding.encodeBase64Url(
        JSON.stringify({
          workflow: identity?.workflow ?? null,
          instanceId: identity?.instanceId ?? null,
          step,
          errors,
        }),
      )}\n${summary}`;
      const message = `${failurePrefix}${await failureDigest(body)}:${body}`;
      if (new TextEncoder().encode(message).byteLength > maxFailureLength)
        throw new TypeError("encoded failure exceeds 16 KiB");
      return new Error(message);
    } catch (error) {
      throw await terminalFailure(
        `Workflow application failure is not serializable: ${error instanceof Error ? error.message : "unsupported value"}`,
      );
    }
  }
  const error = Cause.squash(cause);
  return terminalFailure(
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Workflow callback defect or interruption",
  );
};

const failureDigest = async (body: string): Promise<string> =>
  Encoding.encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  );

export const decodeApplicationFailure = async <E>(
  error: unknown,
  step: string,
  identity: WorkflowIdentity | undefined,
): Promise<Cause.Cause<E> | undefined> => {
  if (
    !identity?.workflow ||
    !identity.instanceId ||
    !(error instanceof Error) ||
    error.name !== "Error" ||
    !error.message.startsWith(failurePrefix)
  )
    return undefined;
  try {
    if (new TextEncoder().encode(error.message).byteLength > maxFailureLength)
      throw new TypeError("encoded failure exceeds 16 KiB");
    const encoded = error.message.slice(failurePrefix.length);
    const separator = encoded.indexOf(":");
    const digest = encoded.slice(0, separator);
    const body = encoded.slice(separator + 1);
    if (separator !== 43 || digest !== (await failureDigest(body)))
      throw new TypeError("invalid failure checksum");
    const end = body.indexOf("\n");
    if (end < 1) throw new TypeError("invalid failure framing");
    const json = Encoding.decodeBase64UrlString(body.slice(0, end));
    if (Result.isFailure(json)) throw new TypeError("invalid failure encoding");
    const envelope: unknown = JSON.parse(json.success);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("workflow" in envelope) ||
      envelope.workflow !== identity.workflow ||
      !("instanceId" in envelope) ||
      envelope.instanceId !== identity.instanceId ||
      !("step" in envelope) ||
      envelope.step !== step ||
      !("errors" in envelope) ||
      !Array.isArray(envelope.errors) ||
      envelope.errors.length === 0 ||
      Object.keys(envelope).length !== 4
    )
      throw new TypeError("invalid failure envelope");
    // Only the validated private transport restores E's data; prototypes and identity are invocation-local.
    const errors = envelope.errors.map((value) =>
      decodeFailureValue(value),
    ) as E[];
    return Cause.fromReasons(
      errors.map((value) => Cause.makeFailReason(value)),
    );
  } catch (cause) {
    throw new TypeError("Invalid persisted Workflow application failure", {
      cause,
    });
  }
};

type FailureValue = null | boolean | string | number | FailureValue[];

const encodeFailureValue = (
  value: unknown,
  ancestors = new Set<object>(),
  budget = { nodes: 0, seen: new Set<object>() },
): FailureValue => {
  if (
    ++budget.nodes > maxFailureLength ||
    (typeof value === "string" && value.length > maxFailureLength)
  )
    throw new TypeError("encoded failure exceeds 16 KiB");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (typeof value !== "object")
    throw new TypeError(`unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("cyclic error data");
  if (budget.seen.has(value))
    throw new TypeError("shared references in error data");
  budget.seen.add(value);
  if (ancestors.size >= 64)
    throw new TypeError("error data exceeds 64 nesting levels");
  ancestors.add(value);
  try {
    const encode = (item: unknown) =>
      encodeFailureValue(item, ancestors, budget);
    const symbols = Object.getOwnPropertySymbols(value).filter(
      (key) =>
        !(
          value instanceof Error &&
          key === Symbol.for("effect/Data/Error/plainArgs")
        ),
    );
    if (symbols.length) throw new TypeError("symbol-keyed error data");
    if (
      value instanceof Date ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer ||
      value instanceof Map ||
      value instanceof Set
    ) {
      const own = Object.getOwnPropertyNames(value);
      if (
        own.some(
          (key) => !(value instanceof Uint8Array && /^(0|[1-9]\d*)$/.test(key)),
        )
      )
        throw new TypeError("custom properties on serialized built-in values");
      if (value instanceof Date)
        return ["date", encode(Date.prototype.getTime.call(value))];
      if (value instanceof Uint8Array)
        return ["bytes", Encoding.encodeBase64(value)];
      if (value instanceof ArrayBuffer)
        return ["buffer", Encoding.encodeBase64(new Uint8Array(value))];
      if (value instanceof Map)
        return [
          "map",
          [...Map.prototype.entries.call(value)].map(([key, item]) => [
            encode(key),
            encode(item),
          ]),
        ];
      return ["set", [...Set.prototype.values.call(value)].map(encode)];
    }
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== "length" &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
        )
      )
        throw new TypeError("sparse arrays or custom array properties");
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor))
          throw new TypeError("accessor error data");
      }
      return [
        "array",
        Array.from({ length: value.length }, (_, i) =>
          encode(descriptors[i].value),
        ),
      ];
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let tag: string | undefined;
    for (
      let owner: object | null = value;
      owner;
      owner = Object.getPrototypeOf(owner)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, "_tag");
      if (!descriptor) continue;
      if (!("value" in descriptor)) throw new TypeError("accessor error data");
      if (typeof descriptor.value === "string") tag = descriptor.value;
      break;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      !(value instanceof Error) &&
      prototype !== null &&
      prototype !== Object.prototype &&
      tag === undefined
    )
      throw new TypeError("unsupported class instance");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !("value" in descriptor) &&
        !(value instanceof Error && key === "stack")
      )
        throw new TypeError("accessor error data");
    }
    const fields = new Map<string, unknown>();
    if (tag !== undefined) fields.set("_tag", tag);
    if (value instanceof Error) {
      for (const key of ["name", "message", "stack"]) {
        let owner: object | null = value;
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key);
          if (descriptor) {
            if (
              !("value" in descriptor) &&
              !(owner === value && key === "stack")
            )
              throw new TypeError("accessor error data");
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      for (const [key, item] of Object.entries(
        encodeRpcError(value) as Record<string, unknown>,
      ))
        fields.set(key, item);
      fields.set("name", value.name);
      fields.set("message", value.message);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        if (value instanceof Error && key === "stack")
          fields.set(key, value.stack);
        else throw new TypeError("accessor error data");
      } else fields.set(key, descriptor.value);
    }
    return [
      value instanceof Error ? "error" : "object",
      [...fields].map(([key, item]) => [key, encode(item)]),
    ];
  } finally {
    ancestors.delete(value);
  }
};

const decodeFailureValue = (value: unknown, depth = 0): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (!Array.isArray(value))
    throw new TypeError("invalid serialized error value");
  const decode = (item: unknown) => decodeFailureValue(item, depth + 1);
  const [tag, data] = value;
  if (tag === "undefined" && value.length === 1) return undefined;
  if (value.length !== 2) throw new TypeError("invalid serialized error tuple");
  if (
    tag === "number" &&
    typeof data === "string" &&
    ["NaN", "Infinity", "-Infinity", "-0"].includes(data)
  )
    return Number(data);
  if (
    tag === "bigint" &&
    typeof data === "string" &&
    /^-?(0|[1-9]\d*)$/.test(data)
  )
    return BigInt(data);
  if (depth >= 64) throw new TypeError("invalid serialized error value");
  if (tag === "date") {
    const timestamp = decode(data);
    if (typeof timestamp === "number") return new Date(timestamp);
  }
  if ((tag === "bytes" || tag === "buffer") && typeof data === "string") {
    const bytes = Encoding.decodeBase64(data);
    if (
      Result.isSuccess(bytes) &&
      Encoding.encodeBase64(bytes.success) === data
    )
      return tag === "bytes" ? bytes.success : bytes.success.buffer;
  }
  if (Array.isArray(data)) {
    if (tag === "array") return data.map(decode);
    if (tag === "set") return new Set(data.map(decode));
    if (tag === "map")
      return new Map(
        data.map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2)
            throw new TypeError("invalid serialized map");
          return [decode(pair[0]), decode(pair[1])];
        }),
      );
    if (tag === "object" || tag === "error") {
      const result = tag === "error" ? new Error() : {};
      const keys = new Set<string>();
      for (const pair of data) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          keys.has(pair[0])
        )
          throw new TypeError("invalid serialized error fields");
        keys.add(pair[0]);
        Object.defineProperty(result, pair[0], {
          value: decode(pair[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
  throw new TypeError("invalid serialized error value");
};
