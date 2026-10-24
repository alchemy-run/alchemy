import { describe, expect, it } from "@alchemy.run/test";
import { hasRoute, mostSpecific, type Route } from "@/Egress/Route.ts";

const route = (host: string, id: string, paths?: ReadonlyArray<string>): Route => ({
  host,
  paths,
  gateway: { id, url: `https://${id}.example/` },
  grant: `grant-${id}`,
});

describe("Egress.Route", { tags: ["unit", "local"] }, () => {
  const routes = [
    route("api.anthropic.com", "work"),
    route("github.com", "work", ["/alchemy-run/alchemy/**"]),
    route("github.com", "user", ["/sam/dotfiles/**"]),
    route("api.github.com", "work", ["/repos/alchemy-run/alchemy/**"]),
    route("api.github.com", "graphql", ["/graphql"]),
    route("api.github.com", "fallback"),
  ];

  it("a route without paths covers the whole host", () => {
    expect(mostSpecific(routes, "api.anthropic.com", "/v1/messages")?.gateway.id).toBe("work");
    expect(mostSpecific(routes, "API.Anthropic.com", "/")?.gateway.id).toBe("work");
  });

  it("picks the route whose pattern matches the path", () => {
    expect(mostSpecific(routes, "github.com", "/alchemy-run/alchemy/info/refs")?.gateway.id).toBe(
      "work",
    );
    expect(mostSpecific(routes, "github.com", "/sam/dotfiles/git-upload-pack")?.gateway.id).toBe(
      "user",
    );
  });

  it("a trailing /** also covers the bare prefix, ignoring the query", () => {
    expect(mostSpecific(routes, "github.com", "/sam/dotfiles?tab=readme")?.gateway.id).toBe("user");
    expect(mostSpecific(routes, "github.com", "/sam/dotfiles-other")).toBeUndefined();
  });

  it("no matching path on a routed host is no route", () => {
    expect(mostSpecific(routes, "github.com", "/octocat/Hello-World")).toBeUndefined();
    expect(mostSpecific(routes, "example.com", "/")).toBeUndefined();
  });

  it("the most specific match wins; a path match beats a whole-host route", () => {
    expect(mostSpecific(routes, "api.github.com", "/graphql")?.gateway.id).toBe("graphql");
    expect(
      mostSpecific(routes, "api.github.com", "/repos/alchemy-run/alchemy/issues/42")?.gateway.id,
    ).toBe("work");
    expect(mostSpecific(routes, "api.github.com", "/user")?.gateway.id).toBe("fallback");
    const nested = [route("h", "outer", ["/a/**"]), route("h", "inner", ["/a/b/**"])];
    expect(mostSpecific(nested, "h", "/a/b/c")?.gateway.id).toBe("inner");
    expect(mostSpecific(nested, "h", "/a/c")?.gateway.id).toBe("outer");
  });

  it("* matches within one segment", () => {
    const star = [route("h", "star", ["/repos/*/issues"])];
    expect(mostSpecific(star, "h", "/repos/x/issues")?.gateway.id).toBe("star");
    expect(mostSpecific(star, "h", "/repos/x/y/issues")).toBeUndefined();
  });

  it("hasRoute is by host only", () => {
    expect(hasRoute(routes, "github.com")).toBe(true);
    expect(hasRoute(routes, "GITHUB.COM")).toBe(true);
    expect(hasRoute(routes, "example.com")).toBe(false);
  });
});
