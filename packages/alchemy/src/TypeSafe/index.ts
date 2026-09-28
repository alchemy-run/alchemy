/**
 * TypeSafe — System One (Jev) as an Alchemy binding, speaking effect's
 * native `Decision` language (`effect/unstable/ai`).
 *
 * `TypeSafe.Choice` / `TypeSafe.Noul` / `TypeSafe.Score` are sugar over
 * `Decision.classify` / `Decision.probability` / `Decision.rate` (Choice
 * additionally accepts structured rubric cards), and a judgment's answers
 * are effect `Decision.Answers`.
 */
export * from "./SystemOne.ts";
export * from "./SystemOneHttp.ts";
