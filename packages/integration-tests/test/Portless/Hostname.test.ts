import * as Portless from "@alchemy.run/portless";
import {
  hostnameOf,
  originOf,
  routedName,
  stageLabel,
} from "@alchemy.run/portless/internal/Hostname";
import { describe, expect, it } from "@alchemy.run/test";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

// Pure helpers: no providers, no proxy.

const withStage = (stage: string) => Effect.provideService(Stage, stage);
const withEnv = (env: Record<string, string>) =>
  Effect.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)));

describe("hostname grammar", () => {
  it("names a service <stage>.<kebab id>.<domain>.localhost", () => {
    expect(routedName("Api", "dev-alice", "myapp")).toBe("dev-alice.api.myapp");
    expect(routedName("ExampleService", "dev-example-feature", "example")).toBe(
      "dev-example-feature.example-service.example",
    );
    expect(Effect.runSync(hostnameOf(routedName("Api", "dev-alice", "myapp")))).toBe(
      "dev-alice.api.myapp.localhost",
    );
  });

  it("makes the stage DNS-safe: Alchemy's default dev_alice is dev-alice", () => {
    expect(stageLabel("dev_alice")).toBe("dev-alice");
    expect(stageLabel("Dev_Alice")).toBe("dev-alice");
    expect(stageLabel("feature/foo.bar")).toBe("feature-foo-bar");
    // A stage that already is a DNS label does not change, so adopting the package keeps URLs.
    expect(stageLabel("dev-example-feature")).toBe("dev-example-feature");
    expect(stageLabel("pr-1234")).toBe("pr-1234");
  });

  it("leaves the port out of an origin on 443 and keeps any other", () => {
    expect(originOf("dev-alice.api.myapp.localhost", 443)).toBe(
      "https://dev-alice.api.myapp.localhost",
    );
    expect(originOf("dev-alice.api.myapp.localhost", 8443)).toBe(
      "https://dev-alice.api.myapp.localhost:8443",
    );
  });

  it("rejects a name Portless can't serve with a typed error", () => {
    const exit = Effect.runSyncExit(hostnameOf(routedName("Api", "dev-alice", "my app")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("HostnameInvalid");
    }
  });
});

describe("Portless.Origin", () => {
  it("is the origin of the service a string domain names", () => {
    const origin = Portless.Origin("Web", { proxy: { domain: "myapp" } }).pipe(
      withStage("dev_alice"),
      withEnv({}),
      Effect.runSync,
    );
    expect(origin).toBe("https://dev-alice.web.myapp.localhost");
  });

  it("includes a proxy port other than 443", () => {
    const origin = Portless.Origin("Web", { proxy: { domain: "myapp", port: 8443 } }).pipe(
      withStage("dev-alice"),
      withEnv({}),
      Effect.runSync,
    );
    expect(origin).toBe("https://dev-alice.web.myapp.localhost:8443");
  });

  it("is an Output when the proxy's domain is one", () => {
    const origin = Portless.Origin("Web", {
      proxy: { domain: Output.asOutput("myapp"), port: Output.asOutput(443) },
    } as never).pipe(withStage("dev-alice"), withEnv({}), Effect.runSync);
    expect(Output.isOutput(origin)).toBe(true);
  });

  it("is http://localhost:<port> with PORTLESS=0", () => {
    for (const value of ["0", "false", "skip"]) {
      const origin = Portless.Origin("Web", { proxy: { domain: "myapp" }, port: 5173 }).pipe(
        withStage("dev-alice"),
        withEnv({ PORTLESS: value }),
        Effect.runSync,
      );
      expect(origin).toBe("http://localhost:5173");
    }
  });

  it("fails with PORTLESS=0 and no port", () => {
    const exit = Portless.Origin("Web", { proxy: { domain: "myapp" } }).pipe(
      withStage("dev-alice"),
      withEnv({ PORTLESS: "0" }),
      Effect.runSyncExit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("OriginPortRequired");
  });
});
