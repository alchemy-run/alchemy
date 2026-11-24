import {
  matchRoute,
  routePatternAllowedHost,
  routePatternUrl,
} from "@alchemy.run/cloudflare/Workers/RoutePattern";
import { describe, expect, it } from "@alchemy.run/test";

const route = (pattern: string) => ({ pattern });

describe(
  "matchRoute",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  () => {
    it("matches Cloudflare route semantics", () => {
      const routes = [
        route("example.com/*"),
        route("example.com/users/*"),
        route("example.com/users/health"),
        route("*.example.com/*"),
        route("www.example.com/*"),
        route("https://secure.example.com/app*"),
      ];
      const match = (host: string, path: string) => matchRoute(routes, host, path)?.pattern;

      expect(match("example.com", "/")).toBe("example.com/*");
      // The longer path wins.
      expect(match("example.com", "/users/1")).toBe("example.com/users/*");
      // `/users/*` does not match `/users`.
      expect(match("example.com", "/users")).toBe("example.com/*");
      // An exact path beats a prefix.
      expect(match("example.com", "/users/health")).toBe("example.com/users/health");
      // An exact host beats a wildcard host.
      expect(match("www.example.com", "/")).toBe("www.example.com/*");
      expect(match("api.example.com", "/")).toBe("*.example.com/*");
      // Hosts are case-insensitive, paths case-sensitive.
      expect(match("EXAMPLE.com", "/Users/1")).toBe("example.com/*");
      // A scheme is optional; `*` matches zero characters.
      expect(match("secure.example.com", "/app")).toBe("https://secure.example.com/app*");
      expect(match("other.com", "/")).toBeUndefined();
    });

    it("derives the deployed origin of a pattern", () => {
      expect(routePatternUrl("api.example.com/users/*")).toBe("https://api.example.com");
      expect(routePatternUrl("http://api.example.com/*")).toBe("http://api.example.com");
      expect(routePatternUrl("*.example.com/*")).toBeUndefined();
    });

    it("derives the host a Vite dev server must allow", () => {
      // A literal host is allowed as is, with or without scheme and path.
      expect(routePatternAllowedHost("api.example.com/users/*")).toBe("api.example.com");
      expect(routePatternAllowedHost("https://API.example.com/*")).toBe("api.example.com");
      // `*.example.com` is Vite's leading-dot form (it also admits the apex).
      expect(routePatternAllowedHost("*.example.com/*")).toBe(".example.com");
      // Vite cannot name a suffix wildcard (`fooexample.com` would match), and
      // a bare `*` host matches everything: the app's own `allowedHosts` rules.
      expect(routePatternAllowedHost("*example.com/*")).toBeUndefined();
      expect(routePatternAllowedHost("*/*")).toBeUndefined();
    });
  },
);
