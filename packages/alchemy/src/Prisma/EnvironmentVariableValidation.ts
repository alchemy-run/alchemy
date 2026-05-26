import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_VALUE_MAX_BYTES = 8 * 1024;

const valueOf = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

export const validateEnvironmentVariableKey = (key: string) =>
  Effect.gen(function* () {
    if (key.length < 1 || key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
        ),
      );
    }
  });

export const validateEnvironmentVariableWrite = (
  key: string,
  value: string | Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    yield* validateEnvironmentVariableKey(key);
    const raw = valueOf(value);
    if (raw.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value must be non-empty.`,
        ),
      );
    }
    const byteLength = yield* Effect.sync(
      () => new TextEncoder().encode(raw).byteLength,
    );
    if (byteLength > ENV_VALUE_MAX_BYTES) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value exceeds ${ENV_VALUE_MAX_BYTES} bytes.`,
        ),
      );
    }
  });
