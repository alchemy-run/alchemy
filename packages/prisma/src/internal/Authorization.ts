import * as Redacted from "effect/Redacted";

export const authorizationHeader = (
  token: Redacted.Redacted<string> | undefined,
): { Authorization?: Redacted.Redacted<string> } =>
  token ? { Authorization: Redacted.make(`Bearer ${Redacted.value(token)}`) } : {};
