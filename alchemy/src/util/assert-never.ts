import { inspect } from "node:util";

export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${inspect(value)}`);
}
