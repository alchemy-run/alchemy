import * as Data from "effect/Data";

export class ProviderCommandLoadError extends Data.TaggedError(
  "ProviderCommandLoadError",
)<{
  readonly message: string;
  readonly provider: string;
  readonly installCommand: string;
  readonly cause: unknown;
}> {}
