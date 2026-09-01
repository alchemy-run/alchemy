import { secretScope, variableScope } from "@/Forgejo/index.ts";
import { describe, expect, test } from "alchemy-test";
import * as Redacted from "effect/Redacted";

describe("Actions scopes", () => {
  test("preserves legacy repository secret and variable props", () => {
    expect(
      secretScope({
        owner: "acme",
        repository: "api",
        name: "TOKEN",
        value: Redacted.make("secret"),
      }),
    ).toEqual({ kind: "repository", owner: "acme", repository: "api" });
    expect(
      variableScope({
        owner: "acme",
        repository: "api",
        name: "REGION",
        value: "us-east-1",
      }),
    ).toEqual({ kind: "repository", owner: "acme", repository: "api" });
  });

  test("preserves explicit organization and user scopes", () => {
    expect(
      secretScope({
        scope: { kind: "organization", organization: "acme" },
        name: "TOKEN",
        value: Redacted.make("secret"),
      }),
    ).toEqual({ kind: "organization", organization: "acme" });
    expect(
      variableScope({
        scope: { kind: "user" },
        name: "REGION",
        value: "us-east-1",
      }),
    ).toEqual({ kind: "user" });
  });
});
