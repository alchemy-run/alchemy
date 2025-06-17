//todo(michael):
//  "live" is kind of a misnomer, since some live resources require bundling
//  if live was strict it would entirely kill the way the current CF workers
//  work. so "live" is really root level-live
//
// that being said it might make sense to have a "live-strict" mode for setups
// that want:
// 1. separate alchemy steps for bundling/builds and for deployments
//    (e.g. a `alchemy.build.ts` and a `alchemy.deploy.ts`)
// 2. projects that want to ensure all artifacts are always stored
//    "live-strict" would allow them to ensure there are no local artifacts
// 3. if alchemy.run is called in an environment where there is no "local"
//    (e.g. in a cloudflare worker or in the browser)
//
// side note for 2. this might mean that we would want the mode to apply to the
// state store as well (so "live" would be root level-live except state store
// which can be local)

export type ModeType =
  | "dev" //todo(michael): we call this dev mode but the resources are called local
  | "live"
  | "hybrid-prefer-live"
  | "hybrid-prefer-dev"; // | "hybrid";
export const DEFAULT_MODE = "hybrid-prefer-live";
