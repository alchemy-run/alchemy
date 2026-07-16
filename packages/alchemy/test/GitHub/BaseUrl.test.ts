import { readEnvCredentials } from "@/GitHub/AuthProvider";
import { GitHubCredentials, fromToken } from "@/GitHub/Credentials";
import {
  githubHostname,
  normalizeGitHubBaseUrl,
  resolveGitHubBaseUrlFromEnv,
} from "@/GitHub/BaseUrl";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, test } from "vitest";

const normalize = (input: string) =>
  Effect.runSync(normalizeGitHubBaseUrl(input));

describe("normalizeGitHubBaseUrl", () => {
  test("github.com hosts normalize to undefined (Octokit default)", () => {
    expect(normalize("github.com")).toBeUndefined();
    expect(normalize("https://github.com")).toBeUndefined();
    expect(normalize("https://www.github.com/")).toBeUndefined();
    expect(normalize("https://api.github.com")).toBeUndefined();
  });

  test("GitHub Enterprise Server hosts get /api/v3 appended", () => {
    expect(normalize("github.example.com")).toBe(
      "https://github.example.com/api/v3",
    );
    expect(normalize("https://github.example.com")).toBe(
      "https://github.example.com/api/v3",
    );
    expect(normalize("https://github.example.com/")).toBe(
      "https://github.example.com/api/v3",
    );
  });

  test("an explicit API path is honored as-is", () => {
    expect(normalize("https://github.example.com/api/v3")).toBe(
      "https://github.example.com/api/v3",
    );
    expect(normalize("https://github.example.com/api/v3/")).toBe(
      "https://github.example.com/api/v3",
    );
  });

  test("non-default ports and http protocol are preserved", () => {
    expect(normalize("http://github.example.com:8080")).toBe(
      "http://github.example.com:8080/api/v3",
    );
  });

  test("data-residency ghe.com hosts get the api. prefix", () => {
    expect(normalize("acme.ghe.com")).toBe("https://api.acme.ghe.com");
    expect(normalize("https://acme.ghe.com")).toBe("https://api.acme.ghe.com");
    expect(normalize("https://api.acme.ghe.com")).toBe(
      "https://api.acme.ghe.com",
    );
  });

  test("invalid input fails with AuthError", () => {
    const result = Effect.runSync(
      Effect.result(normalizeGitHubBaseUrl("https://")),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("githubHostname", () => {
  test("GHES base URL yields the plain host", () => {
    expect(githubHostname("https://github.example.com/api/v3")).toBe(
      "github.example.com",
    );
  });

  test("data-residency base URL drops the api. prefix", () => {
    expect(githubHostname("https://api.acme.ghe.com")).toBe("acme.ghe.com");
  });
});

describe("resolveGitHubBaseUrlFromEnv", () => {
  // The default ConfigProvider snapshots process.env, so tests inject their
  // environment via a ConfigProvider layer instead of mutating process.env.
  const resolveWith = (env: Record<string, string>) =>
    Effect.runSync(
      resolveGitHubBaseUrlFromEnv.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env }),
        ),
      ),
    );

  test("GITHUB_BASE_URL wins over GITHUB_API_URL", () => {
    expect(
      resolveWith({
        GITHUB_BASE_URL: "https://github.example.com",
        GITHUB_API_URL: "https://api.github.com",
      }),
    ).toBe("https://github.example.com/api/v3");
  });

  test("GITHUB_API_URL pointing at github.com resolves to undefined", () => {
    expect(
      resolveWith({ GITHUB_API_URL: "https://api.github.com" }),
    ).toBeUndefined();
  });

  test("GH_HOST resolves as a bare hostname", () => {
    expect(resolveWith({ GH_HOST: "github.example.com" })).toBe(
      "https://github.example.com/api/v3",
    );
  });

  test("resolves to undefined when nothing is set", () => {
    expect(resolveWith({})).toBeUndefined();
  });
});

describe("readEnvCredentials", () => {
  const readWith = (env: Record<string, string>, configBaseUrl?: string) =>
    Effect.runSync(
      readEnvCredentials(configBaseUrl).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env }),
        ),
      ),
    );

  test("enterprise token variables win on an enterprise host", () => {
    const creds = readWith({
      GITHUB_BASE_URL: "https://github.example.com",
      GH_ENTERPRISE_TOKEN: "enterprise-token",
      GITHUB_TOKEN: "standard-token",
    });
    expect(creds.baseUrl).toBe("https://github.example.com/api/v3");
    expect(creds.source.details).toBe("GH_ENTERPRISE_TOKEN");
  });

  test("enterprise token variables are ignored on github.com", () => {
    const creds = readWith({
      GH_ENTERPRISE_TOKEN: "enterprise-token",
      GITHUB_TOKEN: "standard-token",
    });
    expect(creds.baseUrl).toBeUndefined();
    expect(creds.source.details).toBe("GITHUB_TOKEN");
  });

  test("an explicit config baseUrl wins over the environment", () => {
    const creds = readWith(
      {
        GITHUB_BASE_URL: "https://other.example.com",
        GITHUB_ACCESS_TOKEN: "token",
      },
      "https://github.example.com/api/v3",
    );
    expect(creds.baseUrl).toBe("https://github.example.com/api/v3");
    expect(creds.source.details).toBe("GITHUB_ACCESS_TOKEN");
  });

  test("fails with AuthError when no token variable is set", () => {
    const result = Effect.runSync(
      Effect.result(
        readEnvCredentials().pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: {} }),
          ),
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("fromToken", () => {
  const octokitOf = (options?: { baseUrl?: string }) =>
    Effect.runSync(
      Effect.gen(function* () {
        const creds = yield* yield* GitHubCredentials;
        return creds.octokit();
      }).pipe(Effect.provide(fromToken("test-token", options))),
    );

  test("defaults to api.github.com", () => {
    const octokit = octokitOf();
    expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
      "https://api.github.com",
    );
  });

  test("passes the normalized enterprise base URL to Octokit", () => {
    const octokit = octokitOf({ baseUrl: "github.example.com" });
    expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
      "https://github.example.com/api/v3",
    );
  });
});
