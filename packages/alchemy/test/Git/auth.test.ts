/**
 * The auth contract's shipped pieces, in isolation: header parsing, the
 * shared-secret authenticator, and the default owner policy. No Worker,
 * no cloud.
 */
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Authenticate,
  AuthenticateSecret,
  parseBasic,
  parseBearer,
  parseSecret,
  Policy,
  PolicyOwners,
  type RepoContext,
} from "@/Git/Auth.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const basic = (user: string, password: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});

describe("header parsing", () => {
  it("reads Basic, Bearer, and GitHub's token scheme", () => {
    expect(parseBasic(basic("x", "s3cret"))).toEqual({
      username: "x",
      password: "s3cret",
    });
    expect(parseBasic(basic("x", "with:colon"))?.password).toBe("with:colon");
    expect(parseBearer({ authorization: "Bearer abc" })).toBe("abc");
    expect(parseBearer({ authorization: "token abc" })).toBe("abc");
    expect(parseBearer(basic("x", "s3cret"))).toBeUndefined();
    expect(parseSecret(basic("x", "s3cret"))).toBe("s3cret");
    expect(parseSecret({ authorization: "Bearer abc" })).toBe("abc");
    expect(parseSecret({})).toBeUndefined();
    expect(parseSecret({ authorization: "Digest nope" })).toBeUndefined();
  });
});

describe("AuthenticateSecret", () => {
  const layer = AuthenticateSecret({ principal: { id: "acme" } }).pipe(
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ GIT_SERVICE_SECRET: "hunter2" }),
      ),
    ),
  );
  const authenticate = (headers: Record<string, string | undefined>) =>
    Effect.gen(function* () {
      const fn = yield* Authenticate;
      return yield* fn(headers);
    }).pipe(Effect.provide(layer), Effect.provide(RuntimeContext.phantom));

  it.effect("resolves the principal for the matching secret only", () =>
    Effect.gen(function* () {
      expect(yield* authenticate({ authorization: "Bearer hunter2" })).toEqual({
        id: "acme",
      });
      expect(yield* authenticate(basic("git", "hunter2"))).toEqual({
        id: "acme",
      });
      expect(
        yield* authenticate({ authorization: "Bearer nope" }),
      ).toBeUndefined();
      expect(yield* authenticate(basic("git", ""))).toBeUndefined();
      expect(yield* authenticate({})).toBeUndefined();
    }),
  );
});

describe("PolicyOwners", () => {
  const repo = (owner: string, isPublic: boolean): RepoContext => ({
    repoId: "r",
    owner,
    name: "web",
    public: isPublic,
    defaultBranch: "main",
    readOnly: false,
  });
  const decide = (input: Parameters<Policy["Service"]["authorize"]>[0]) =>
    Effect.gen(function* () {
      const policy = yield* Policy;
      return yield* policy.authorize(input);
    }).pipe(
      Effect.provide(PolicyOwners),
      Effect.provide(RuntimeContext.phantom),
    );
  const dana = { id: "dana" };
  const push = { _tag: "Push", updates: [] } as const;

  it.effect("anonymous reads public repos and nothing else", () =>
    Effect.gen(function* () {
      expect(
        yield* decide({
          principal: undefined,
          repo: repo("acme", true),
          action: { _tag: "Fetch" },
        }),
      ).toBe(true);
      expect(
        yield* decide({
          principal: undefined,
          repo: repo("acme", true),
          action: push,
        }),
      ).toBe(false);
      expect(
        yield* decide({
          principal: undefined,
          repo: repo("acme", false),
          action: { _tag: "Fetch" },
        }),
      ).toBe(false);
      expect(
        yield* decide({
          principal: undefined,
          repo: null,
          action: { _tag: "CreateRepo", owner: "acme" },
        }),
      ).toBe(false);
    }),
  );

  it.effect(
    "a principal owns what it owns, reads what is public, and may create",
    () =>
      Effect.gen(function* () {
        expect(
          yield* decide({
            principal: dana,
            repo: repo("dana", false),
            action: push,
          }),
        ).toBe(true);
        expect(
          yield* decide({
            principal: dana,
            repo: repo("dana", false),
            action: { _tag: "DeleteRepo" },
          }),
        ).toBe(true);
        expect(
          yield* decide({
            principal: dana,
            repo: repo("acme", false),
            action: push,
          }),
        ).toBe(false);
        expect(
          yield* decide({
            principal: dana,
            repo: repo("acme", false),
            action: { _tag: "ReadRepo" },
          }),
        ).toBe(false);
        expect(
          yield* decide({
            principal: dana,
            repo: repo("acme", true),
            action: { _tag: "ReadRepo" },
          }),
        ).toBe(true);
        expect(
          yield* decide({
            principal: dana,
            repo: null,
            action: { _tag: "CreateRepo", owner: "dana" },
          }),
        ).toBe(true);
        expect(
          yield* decide({
            principal: dana,
            repo: null,
            action: { _tag: "ListRepos" },
          }),
        ).toBe(true);
        // Owner names are lowercased by the engine; ids need not be.
        expect(
          yield* decide({
            principal: { id: "DANA" },
            repo: repo("dana", false),
            action: push,
          }),
        ).toBe(true);
      }),
  );
});
