import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProfileStore, withProfileOverride } from "../Auth/Profile.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";

/**
 * Resolve the selected Alchemy profile after the command's dotenv provider is
 * known. An omitted CLI flag must remain absent so it does not shadow
 * `ALCHEMY_PROFILE` from `.env` / `--env-file`.
 */
export const resolveProfileSelection = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  const base = yield* loadConfigProvider(envFile);
  const profiles = yield* ProfileStore;
  const selected = yield* profiles.current.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      withProfileOverride(base, override),
    ),
  );
  return {
    ...selected,
    source:
      override === undefined ? selected.source : ("command-line" as const),
  };
});

export const resolveProfileName = Effect.fn(function* (
  envFile: Option.Option<string>,
  override: string | undefined,
) {
  return (yield* resolveProfileSelection(envFile, override)).name;
});
