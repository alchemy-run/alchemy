# Egress (design)

A sandbox holds no credentials. Its requests to egress hosts (GitHub,
Anthropic, …) go to an **egress gateway**, which checks them against the
egress rules, adds the real credential, and forwards them. Every other host
goes straight out.

Three declarations, each typed, none configured: a **gateway** names the
egresses it serves by kind; a **sandbox** names the kinds it accepts; a
Durable Object yields both and connects them. Credentials and rules are
configured where they're used, in the gateway's effectful constructor. Each
egress belongs to its gateway at the type level, so only egresses a gateway
serves, of kinds the sandbox accepts, can be granted, and one sandbox can use
several gateways at once:

```ts
const work = yield* WorkGateway; // { model, repo }
const personal = yield* PersonalGateway; // { repo }

yield* sandbox.start({
  size: "large",
  egress: [
    work.model,
    work.repo.narrow({ repository: "alchemy-run/alchemy", issue }),
    personal.repo.narrow({ repository: "sam/dotfiles" }),
  ],
});
```

Nothing is fixed at build time. The Durable Object stores what it granted,
asks each gateway for a short-lived signed **grant**, and pushes a route table
(which host and path go to which gateway, with which grant) to the sandbox. It
renews the grants before they expire. Only the transport differs by host: a
Cloudflare Container reaches a gateway over a native Worker binding, anything
else through a proxy in the sandbox over HTTPS.

```
                     Durable Object that owns the sandbox
                       stores the egresses it granted (and ttl)
                       asks each gateway for a grant; renews them
                            │ push the route table
          ┌─────────────────┴─────────────────┐
          ▼                                   ▼
Cloudflare Container                  microVM / ECS / Fly / local
  git push                              git push
   └ interceptOutboundHttps              └ proxy :3128 (HTTPS_PROXY)
     → relay entrypoint (props)            matches host + path
     → service binding ──────┐             → HTTPS + grant ─────┐
                             ▼                                  ▼
                 Egress gateway (a Worker, a Lambda, …)
                   verify grant → egress handler (rules, credential) → api.github.com
```

## 1. Egress kinds

An egress kind is code that ships with Alchemy (or that you write): the rules
for one service, the type of its scope, and the tools and placeholder
credentials a sandbox needs to use it.

```ts
GitHub.Egress // rules for git, REST and GraphQL; scope { repository, issue?, pullRequest? }; git + gh, GH_TOKEN
Anthropic.Egress // the Messages API; no scope; ANTHROPIC_API_KEY
Egress.Http // any host; host, paths and headers come from its credential
```

A kind is never configured at module scope. Configuring one needs credentials,
and credentials come from bindings (secrets, a D1 table of users' tokens),
which only exist inside an effectful constructor. So kinds are named in
declarations, and configured in the gateway's implementation (section 2).

## 2. Declare a gateway and implement it

The declaration names the egresses a gateway serves and their kinds. It holds
no configuration and no credentials, so it is cheap to import anywhere:

```ts
// src/gateway.ts
import * as Anthropic from "alchemy/Anthropic";
import * as Egress from "alchemy/Egress";
import * as GitHub from "alchemy/GitHub";

export class WorkGateway extends Egress.Gateway<WorkGateway>()("WorkGateway", {
  model: Anthropic.Egress,
  repo: GitHub.Egress,
}) {}

export class UserGateway extends Egress.Gateway<UserGateway>()("UserGateway", {
  repo: GitHub.Egress,
  custom: Egress.Http,
}) {}
```

The implementation is an effectful constructor: it yields its bindings, then
configures each egress. `Gateway.serve` turns it into a whole Worker (or
Lambda) implementation, and checks it against the declaration: a missing
name, an extra one, or the wrong kind doesn't compile.

```ts
// src/gateway.worker.ts
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { WorkGateway } from "./gateway.ts";

export default Cloudflare.Worker(
  "WorkGatewayWorker",
  { main: import.meta.url },
  WorkGateway.serve(
    Effect.gen(function* () {
      return {
        model: yield* Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }),
        repo: yield* GitHub.Egress({
          token: GitHub.ProfileToken,
          repositories: [
            {
              repository: "alchemy-run/alchemy",
              contents: "write",
              pullRequests: "write",
              issues: "write",
              push: { branches: ["agent/**"] },
            },
          ],
        }),
      };
    }),
  ),
);
```

### Credentials from a database

Whose credential to use is data. A credential can be a function of the
subject carried in the signed grant, using a binding the constructor yielded:

```ts
// src/gateway.lambda.ts — the same pattern on a Lambda with a function URL
import * as AWS from "alchemy/AWS";
import * as Egress from "alchemy/Egress";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import { UserGateway } from "./gateway.ts";
import { Credentials } from "./credentials.ts"; // a DynamoDB table of users' credentials

export default AWS.Lambda.Function(
  "UserGatewayLambda",
  { main: import.meta.url, url: true },
  UserGateway.serve(
    Effect.gen(function* () {
      const credentials = yield* AWS.DynamoDB.GetItem(Credentials);
      const lookup = (subject: string) =>
        credentials({ Key: { subject: { S: subject } } }).pipe(Effect.map(({ Item }) => Item!));
      return {
        // per request (cached per subject); `subject` comes from the signed grant
        repo: yield* GitHub.Egress({
          token: ({ subject }) => lookup(subject).pipe(Effect.map((item) => item.githubToken.S!)),
        }),
        // host, paths and headers all come from the stored credential
        custom: yield* Egress.Http({
          credential: ({ subject }) => lookup(subject).pipe(Effect.map(toHttpCredential)),
        }),
      };
    }).pipe(Effect.provide(AWS.DynamoDB.GetItemLive)),
  ),
);
```

Rotating or revoking a stored credential is a database write: the next
request gets the new answer, or fails.

### Inside a Worker you already have

```ts
// src/worker.ts
const gateway = yield* WorkGateway.serve(implementation);
return {
  fetch: Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (new URL(request.url, "http://x").pathname === "/egress") return yield* gateway.fetch;
    // ...
  }),
};
```

## 3. Declare the sandbox and its hosts

```ts
// src/Sandbox.ts — the shape the Durable Object uses: start, exec, setEgress, stop
import * as AI from "alchemy/AI";

// The declaration types start(): the sizes it takes, and the egress kinds it accepts.
export class Sandbox extends AI.Sandbox<
  Sandbox,
  {
    size: "small" | "large";
    egress: GitHub.Egress | Anthropic.Egress;
  }
>()("Sandbox") {}
```

Each host installs the tools for the accepted kinds at deploy (`git` and `gh`
for `GitHub.Egress`). `start` sets the placeholder credentials
(`GH_TOKEN=alchemy-egress`) at run time, for the egresses actually granted.

A host constructor takes the declaration, the host's props and the program.
The program provides its own layers, because only code written for a host
knows what that host offers. Hosts say nothing about gateways:

```ts
// src/Sandbox.cloudflare.ts
import * as Anthropic from "alchemy/Anthropic";
import * as Cloudflare from "alchemy/Cloudflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export default Cloudflare.Containers.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    // A name is an instance type, chosen at start(): no extra builds.
    sizes: { small: "basic", large: "standard-4" },
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
```

```ts
// src/Sandbox.microvm.ts
import * as Anthropic from "alchemy/Anthropic";
import * as AWS from "alchemy/AWS";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandbox } from "./Sandbox.ts";

export default AWS.MicroVM.Sandbox(
  Sandbox,
  {
    main: import.meta.url,
    image: "node:24-bookworm",
    // One microVM image per name, built at deploy; start() picks the image.
    sizes: { small: "4 GB", large: "32 GB" },
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, AWS.MicroVM.Metadata)),
  ),
);
```

Sizes are named, not measured, because hosts size differently. A Cloudflare
Container picks its instance type at `start()`. A Lambda microVM's memory is
fixed on its image (`CreateMicrovmImage.resources`; `RunMicrovm` has no size),
so each size is its own image. Each host maps every declared name; a missing
or extra name doesn't compile:

```ts
AWS.MicroVM.Sandbox(Sandbox, { sizes: { small: "4 GB" } }, program);
// ✗ Property 'large' is missing in type '{ small: "4 GB" }'
```

A harness server (`Anthropic.ClaudeCodeServer`, `OpenAI.CodexServer`,
`OpenCode.Server`, `AI.AcpServer`) yields `{ fetch }`, so it can be the whole
program, as above. Next to your own routes, route to its `fetch`:

```ts
Effect.gen(function* () {
  const claude = yield* Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" });
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.url === "/health") return HttpServerResponse.text("ok");
      return yield* claude.fetch;
    }),
  };
});
```

## 4. Grant egresses to a sandbox

```ts
// src/Agent.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { UserGateway, WorkGateway } from "./gateway.ts";
import { Sandbox } from "./Sandbox.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const work = yield* WorkGateway; // { model, repo }
    const user = yield* UserGateway; // { repo, custom }

    return Effect.gen(function* () {
      return {
        work: (issue: number, userId: string) =>
          sandbox.start({
            size: "large",
            egress: [
              work.model,
              work.repo.narrow({ repository: "alchemy-run/alchemy", issue }),
              // narrow restricts access; for() chooses whose credential
              user.repo.narrow({ repository: "sam/dotfiles" }).for(userId),
            ],
            ttl: "5 minutes", // each grant's lifetime (the default)
          }),
        // Applies at once, on live connections too.
        modelOnly: () => sandbox.setEgress({ egress: [work.model] }),
        settle: () => sandbox.stop(),
      };
    });
  }),
) {}
```

Only a gateway's own egresses are in reach, only kinds the sandbox accepts can
be granted, and `narrow` takes the kind's scope type:

```ts
work.stripe;
// ✗ Property 'stripe' does not exist on type 'WorkGateway'
sandbox.start({ size: "large", egress: [user.custom] });
// ✗ 'Egress.Http' is not assignable to 'GitHub.Egress | Anthropic.Egress'
work.repo.narrow({ repo: "alchemy-run/alchemy" });
// ✗ Object literal may only specify known properties, and 'repo' does not exist in type 'GitHub.Scope'
```

Which repositories a gateway's `repo` actually allows is configuration, so a
`narrow` outside them is refused by the gateway when it mints the grant
(`EgressNotServed`), at `start`.

`work.repo` and `user.repo` both want `github.com` and `api.github.com`.
Routing is by host and path, so they can share a host when their paths don't
overlap (section 7). When they would overlap, `start` fails with a typed
`EgressRouteConflict`.

```ts
// src/worker.ts — hosts Agent
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Agent } from "./Agent.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const issue = Number(url.searchParams.get("issue"));
        yield* (yield* agents.getByName(`issue-${issue}`)).work(issue, url.searchParams.get("user")!);
        return HttpServerResponse.text("started");
      }),
    };
  }),
) {}
```

## 5. Pick the platform

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import UserGatewayLambda from "./src/gateway.lambda.ts";
import WorkGatewayWorker from "./src/gateway.worker.ts";
import SandboxLive from "./src/Sandbox.cloudflare.ts"; // or ./src/Sandbox.microvm.ts
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "Harness",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { api: api.url.as<string>() };
  }).pipe(
    // Which host serves each gateway: provided like the sandbox's host.
    Effect.provide(Layer.mergeAll(SandboxLive, WorkGatewayWorker, UserGatewayLambda)),
  ),
);
```

A gateway declaration with no host provided leaves `yield* WorkGateway`
unsatisfied, so the stack doesn't type-check, just like `Sandbox`.

## 6. What `yield* Gateway` gives the Durable Object

```ts
// alchemy internal: Egress/Gateway.ts
export type GatewayEgresses<G> = {
  readonly [K in keyof Egresses<G>]: GrantableEgress<G, Egresses<G>[K]>;
};

export interface GrantableEgress<G, E> {
  readonly gateway: G; // a value from this gateway can only be granted by it
  readonly ref: EgressRef;
  narrow(scope: ScopeOf<E>): GrantableEgress<G, E>;
  for(subject: string): GrantableEgress<G, E>; // only on egresses with a resolver
}

export interface EgressRef {
  readonly gateway: string; // the gateway's id: "WorkGateway"
  readonly egress: string; // its name in the gateway: "repo"
  readonly scope?: unknown; // what narrow() was given
  readonly subject?: string; // what for() was given
}
```

At deploy time, yielding a gateway binds how to reach it and how to ask it for
grants. Grants are always minted by the gateway, so its key never leaves it.
The platform authenticates the caller:

```ts
// alchemy internal: Egress/Gateway.ts — what `yield* WorkGateway` binds into the Durable Object's Worker
const host = yield* GatewayHost(WorkGateway); // whichever host the stack provided
if (host.kind === "worker") {
  yield* worker.bind`EgressGateway(WorkGateway)`({
    bindings: [{ type: "service", name: "ALCHEMY_EGRESS_WorkGateway", service: host.workerName }],
  });
} else {
  // A Lambda: invoked with IAM; the URL is for the sandbox's traffic.
  yield* worker.bind`EgressGateway(WorkGateway)`({
    env: { ALCHEMY_EGRESS_WorkGateway_URL: host.url, ALCHEMY_EGRESS_WorkGateway_FUNCTION: host.functionArn },
    policyStatements: [{ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [host.functionArn] }],
  });
}
```

```ts
// at run time, per gateway
interface GatewayClient {
  readonly id: string;
  readonly url: string; // the sandbox's traffic goes here (HTTPS transport)
  readonly fetcher?: Cloudflare.Fetcher; // or here (Cloudflare transport), when it's a Worker
  /** Ask the gateway to sign a grant: service binding RPC, or Lambda InvokeFunction. */
  mint(egress: ReadonlyArray<EgressRef>, ttl: Duration.Duration): Effect.Effect<Grant, EgressNotServed>;
}
```

## 7. Routes: host and path

Each egress says which requests it covers. Static egresses know this from
their declaration and scope; dynamic ones from their resolver at mint time.
GitHub's `narrow` turns a repository into paths:

```ts
work.repo.narrow({ repository: "alchemy-run/alchemy", issue: 42 }).ref;
// covers:
//   github.com/alchemy-run/alchemy/**            (git)
//   api.github.com/repos/alchemy-run/alchemy/**  (REST)
//   api.github.com/graphql                       (GraphQL: by host; the gateway checks the query)
```

The sandbox gets one route table for all its gateways. The most specific
match wins; two egresses that cover the same host with no path to tell them
apart fail `start` with `EgressRouteConflict`:

```ts
interface Route {
  readonly host: string;
  readonly paths?: ReadonlyArray<string>; // absent: the whole host
  readonly gateway: { readonly id: string; readonly url: string };
  readonly grant: string; // that gateway's grant, encoded
}

// e.g. for the Agent in section 4
[
  { host: "api.anthropic.com", gateway: Work, grant: g1 },
  { host: "github.com", paths: ["/alchemy-run/alchemy/**"], gateway: Work, grant: g1 },
  { host: "api.github.com", paths: ["/repos/alchemy-run/alchemy/**"], gateway: Work, grant: g1 },
  { host: "github.com", paths: ["/sam/dotfiles/**"], gateway: User, grant: g2 },
  { host: "api.github.com", paths: ["/repos/sam/dotfiles/**"], gateway: User, grant: g2 },
]
// api.github.com/graphql is claimed by both repo egresses with no path: EgressRouteConflict,
// unless one of them is granted without GraphQL (narrow({ ..., graphql: false })).
```

A request that matches no route goes straight out, with no credential.

## 8. How a sandbox's traffic reaches its gateways

### Cloudflare Container: intercept into a relay entrypoint

Interception is per host. The Durable Object intercepts each routed host into
its own Worker's `AlchemyEgress` entrypoint (#2251's `ctx.exports`), with that
host's routes in the props. The relay runs in the Worker, never in the Durable
Object, and the container can't see the props:

```ts
// alchemy internal: Cloudflare/Containers/ContainerClient.ts — in the owning Durable Object
const applyRoutes = (routes: ReadonlyArray<Route>) =>
  Effect.gen(function* () {
    const ctx = yield* Cloudflare.DurableObjectState;
    for (const [host, forHost] of groupByHost(routes)) {
      const relay = yield* ctx.exports.AlchemyEgress({ props: { routes: forHost } });
      yield* container.interceptOutboundHttps(host, relay);
    }
    for (const host of removedHosts(routes)) {
      yield* container.interceptOutboundHttps(host, yield* ctx.exports.AlchemyEgress({ props: { routes: [] } }));
    }
  });
```

```ts
// alchemy internal: the generated Worker entry exports AlchemyEgress next to `default`
export class AlchemyEgress extends WorkerEntrypoint {
  fetch(request: Request) {
    const { routes } = this.ctx.props as { routes: ReadonlyArray<Route> };
    const route = mostSpecific(routes, new URL(request.url).pathname);
    if (!route) return fetch(request); // not an egress request: straight out
    const forwarded = toGatewayRequest(request, route.grant); // Authorization: Macaroon, x-alchemy-target
    // A gateway Worker: its service binding, no public hop. Anything else: its URL.
    const binding = this.env[`ALCHEMY_EGRESS_${route.gateway.id}`] as Fetcher | undefined;
    return binding ? binding.fetch(forwarded) : fetch(route.gateway.url, forwarded);
  }
}
```

Calling `interceptOutboundHttps` again with new props replaces them, even on
open connections, so a renewed grant, `setEgress` and `stop` apply at once.

### Anywhere else: a proxy in the sandbox

The image gets the proxy and the accepted kinds' tools at deploy time. No
gateways, routes or placeholders: those arrive at run time.

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts, at deploy
const image = baseImage.with(
  ...acceptedKinds(Sandbox).flatMap((kind) => kind.tools), // GitHub.Egress: git, gh
  { env: { ALCHEMY_EGRESS_PROXY: "1" } }, // the bootstrap starts the proxy
);

// at start, for the egresses granted
env: { ...placeholdersOf(granted) } // GH_TOKEN=alchemy-egress: tools think they're signed in
```

```ts
// alchemy internal: Runtime/Bootstrap/index.ts — the image's entrypoint, before `main`
await trustEgressCa(); // exists today: writes the CA bundle, sets SSL_CERT_FILE etc.
if (process.env.ALCHEMY_EGRESS_PROXY) {
  await startEgressProxy({
    routes: JSON.parse(process.env.ALCHEMY_EGRESS_ROUTES ?? "[]"), // the first table, from start()
    controlSecret: process.env.ALCHEMY_EGRESS_CONTROL_SECRET!,
  });
}
await runMain();
```

```ts
// alchemy internal: Runtime/Bootstrap/EgressProxy.ts
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { makeLocalCa } from "../../Egress/LocalCa.ts";
import { mostSpecific, type Route } from "../../Egress/Route.ts";

export const startEgressProxy = async (options: {
  readonly routes: ReadonlyArray<Route>;
  readonly controlSecret: string;
}) => {
  let routes = options.routes; // replaced whenever the Durable Object pushes
  const ca = await makeLocalCa("/etc/cloudflare/certs/cloudflare-containers-ca.crt");

  // A decrypted request for a routed host: pick its route by path, or send it straight out.
  const handle = (req: http.IncomingMessage, res: http.ServerResponse, host: string) => {
    const route = mostSpecific(routes.filter((r) => r.host === host), req.url!);
    const out = route
      ? http.request(route.gateway.url, {
          method: "POST",
          headers: {
            ...req.headers,
            authorization: `Macaroon ${route.grant}`, // replaces the placeholder credential
            "x-alchemy-target": `https://${host}${req.url}`,
            "x-alchemy-method": req.method!,
          },
        })
      : https.request({ host, path: req.url, method: req.method, headers: req.headers });
    out.on("response", (upstream) => {
      res.writeHead(upstream.statusCode!, upstream.headers);
      upstream.pipe(res);
    });
    req.pipe(out); // streamed: a large git push never sits in memory
  };

  // :3128 — what HTTPS_PROXY points at
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    const [host, port = "443"] = req.url!.split(":");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (routes.some((r) => r.host === host)) {
      // Decrypt only hosts that have routes: the path decides, so it must be visible.
      const decrypted = new tls.TLSSocket(socket, { isServer: true, ...ca.leafFor(host!) });
      http.createServer((r, s) => handle(r, s, host!)).emit("connection", decrypted);
    } else {
      // npm, PyPI, docs: tunnelled untouched
      const upstream = net.connect(Number(port), host);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }
  });
  proxy.listen(3128, "127.0.0.1");

  // :3129 — only the Durable Object (holding controlSecret) can replace the routes
  http
    .createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${options.controlSecret}`) {
        return void res.writeHead(401).end();
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      routes = JSON.parse(body); // [] routes nothing
      res.writeHead(204).end();
    })
    .listen(3129, "0.0.0.0");
};
```

## 9. What `Gateway.serve` runs

Two operations, both stateless: mint grants for its own egresses, and serve
granted requests.

```ts
// alchemy internal: Egress/Gateway.ts
export const serve =
  <G extends GatewayDeclaration, R>(gateway: G) =>
  (implementation: Effect.Effect<ConfiguredEgresses<G>, never, R>) =>
  Effect.gen(function* () {
    const key = yield* Random(`${gateway.id}Key`, { bytes: 32 }); // bound into this host only
    const egresses = yield* implementation; // the user's constructor: bindings, credentials, rules

    return {
      /** Called by a Durable Object that yielded this gateway (service binding / InvokeFunction). */
      mint: (egress: ReadonlyArray<EgressRef>, ttl: Duration.Duration) =>
        Effect.gen(function* () {
          // Each egress checks its scope against its configuration (e.g. GitHub's repositories).
          for (const ref of egress) yield* egresses[ref.egress].allows(ref.scope);
          return yield* Grant.mint(key, crypto.randomUUID(), [
            { expires: Date.now() + Duration.toMillis(ttl) },
            ...egress.map((ref) => ({ egress: ref.egress, scope: ref.scope, subject: ref.subject })),
          ]);
        }),

      /** The sandbox's traffic. */
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const grant = yield* Grant.decode(request.headers.authorization);
        if (!(yield* Grant.verify(key, grant))) return HttpServerResponse.text("bad grant", { status: 401 });
        const target = new URL(request.headers["x-alchemy-target"]!);
        const ref = Grant.covering(grant, target, Date.now()); // expiry, then the egress whose routes match
        if (!ref) return HttpServerResponse.text(`${target.host}${target.pathname} is not granted`, { status: 403 });
        // Rules from the declaration, scope and subject from the grant, credential from this host.
        const handle = yield* egresses[ref.egress].handler({ scope: ref.scope, subject: ref.subject });
        return yield* handle(toUpstreamRequest(request, target));
      }),
    };
  });
```

The gateway re-checks the route itself: a grant covers only its own egresses'
hosts and paths, whatever the proxy or relay sent.

## 10. Keeping routes fresh

The Durable Object stores what it granted and renews each gateway's grant
before it expires. Only `apply` differs by host (intercept props, or a push to
the proxy's control port):

```ts
// alchemy internal: AI/Sandbox.ts — shared by every host, runs in the owning Durable Object
interface EgressState {
  readonly ttl: Duration.Duration;
  readonly egress: ReadonlyArray<EgressRef>; // each names its gateway
}
const load = state.storage.get<EgressState>("egress");
const save = (next: EgressState) => state.storage.put("egress", next);

/** Renew at 40% of the TTL: one renewal can fail and the next still lands before expiry. */
const renewIn = (ttl: Duration.Duration) => Duration.toMillis(ttl) * 0.4;

/** One grant per gateway, then one route table for all of them. */
const routes = (s: EgressState) =>
  Effect.gen(function* () {
    const table: Route[] = [];
    for (const [gatewayId, refs] of groupByGateway(s.egress)) {
      const gateway = gatewayClient(gatewayId);
      const grant = Grant.encode(yield* gateway.mint(refs, s.ttl));
      for (const ref of refs) table.push(...routesOf(ref, { id: gateway.id, url: gateway.url }, grant));
    }
    return yield* checkConflicts(table); // EgressRouteConflict
  });

const refresh = (s: EgressState) =>
  Effect.gen(function* () {
    yield* host.apply(yield* routes(s)); // Cloudflare: re-intercept; elsewhere: push to :3129
    yield* state.storage.setAlarm(Date.now() + renewIn(s.ttl));
  });

start: ({ size, egress, ttl }) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const next: EgressState = {
      ttl: ttl !== undefined ? Duration.decode(ttl) : (stored?.ttl ?? Duration.minutes(5)),
      egress: egress !== undefined ? egress.map((e) => e.ref) : (stored?.egress ?? []),
    };
    const table = yield* routes(next); // conflicts fail start before anything is stored
    yield* save(next);
    if (!(yield* host.running)) yield* host.launch({ size, routes: table });
    yield* host.apply(table);
    yield* state.storage.setAlarm(Date.now() + renewIn(next.ttl));
  }),

alarm: () =>
  Effect.gen(function* () {
    const s = yield* load;
    if (s && (yield* host.running)) yield* refresh(s); // from storage: correct after an eviction
  }),

setEgress: ({ egress, ttl }) =>
  Effect.gen(function* () {
    const s = (yield* load)!;
    const next: EgressState = {
      ttl: ttl !== undefined ? Duration.decode(ttl) : s.ttl,
      egress: egress !== undefined ? egress.map((e) => e.ref) : s.egress,
    };
    yield* save(next);
    yield* refresh(next);
  }),

stop: () =>
  host.apply([]).pipe( // routes nothing from now on
    Effect.andThen(host.stop()),
    Effect.andThen(state.storage.deleteAlarm()),
  ),
```

```ts
// alchemy internal: AWS/MicroVM/Sandbox.ts — the microVM host
launch: ({ size, routes }) =>
  Effect.gen(function* () {
    const controlSecret = crypto.randomUUID();
    yield* state.storage.put("controlSecret", controlSecret);
    yield* microvms.run({
      imageIdentifier: imageFor[size], // one image per declared size, built at deploy
      env: {
        ...imageEnv, // GH_TOKEN=alchemy-egress, ALCHEMY_EGRESS_PROXY=1
        ALCHEMY_EGRESS_ROUTES: JSON.stringify(routes), // the first table
        ALCHEMY_EGRESS_CONTROL_SECRET: controlSecret,
        HTTPS_PROXY: "http://127.0.0.1:3128",
        HTTP_PROXY: "http://127.0.0.1:3128",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_USE_ENV_PROXY: "1",
      },
      ports: [3000, 3129], // the harness; the proxy's control port
    });
  }),

apply: (routes) =>
  HttpClient.post(`${machineUrl(3129)}/routes`, {
    body: JSON.stringify(routes),
    headers: { authorization: `Bearer ${controlSecret}` },
  }),
```

## 11. Grants (WebCrypto, no dependency)

An HMAC chain over structured caveats: the useful part of macaroons, without
third-party caveats or the binary format. WebCrypto runs on Workers, Node,
Bun and Lambda alike.

```ts
// alchemy internal: Egress/Grant.ts
export type Caveat =
  | { readonly expires: number }
  | { readonly egress: string; readonly scope?: unknown; readonly subject?: string };

export interface Grant {
  readonly id: string;
  readonly caveats: ReadonlyArray<Caveat>;
  readonly signature: string; // hex HMAC-SHA256
}

const hmac = (key: Uint8Array, data: string) =>
  Effect.promise(async () => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  });

/** sig₀ = HMAC(key, id); sigₙ = HMAC(sigₙ₋₁, caveatₙ) */
const chain = (key: Uint8Array, id: string, caveats: ReadonlyArray<Caveat>) =>
  Effect.gen(function* () {
    let signature = yield* hmac(key, id);
    for (const caveat of caveats) signature = yield* hmac(signature, JSON.stringify(caveat));
    return signature;
  });

export const mint = (key: Uint8Array, id: string, caveats: ReadonlyArray<Caveat>) =>
  chain(key, id, caveats).pipe(Effect.map((sig): Grant => ({ id, caveats, signature: toHex(sig) })));

/** Anyone holding a grant can narrow it; nobody can widen it without the key. */
export const attenuate = (grant: Grant, caveat: Caveat) =>
  hmac(fromHex(grant.signature), JSON.stringify(caveat)).pipe(
    Effect.map((sig): Grant => ({ ...grant, caveats: [...grant.caveats, caveat], signature: toHex(sig) })),
  );

export const verify = (key: Uint8Array, grant: Grant) =>
  chain(key, grant.id, grant.caveats).pipe(
    Effect.map((sig) => constantTimeEqual(sig, fromHex(grant.signature))),
  );

/** On the wire: base64url JSON. */
export const encode = (grant: Grant) => toBase64Url(JSON.stringify(grant));
```

A grant isn't a credential for GitHub or Anthropic. It lets its holder ask one
gateway to run the egresses it names, as narrowed, for the subjects it names,
until it expires. The credentials and the signing key stay in the gateway's
host.

## 12. Where egress state lives

```ts
// Fixed at deploy time: egress rules (code); static credentials and each gateway's key (its host).
// Resolved per request, in the gateway: dynamic credentials (its database), by subject.

// Decided at run time, stored by the owning Durable Object:
yield* state.storage.get("egress");
// {
//   ttl: "5 minutes",
//   egress: [
//     { gateway: "WorkGateway", egress: "model" },
//     { gateway: "WorkGateway", egress: "repo", scope: { repository: "alchemy-run/alchemy", issue: 42 } },
//     { gateway: "UserGateway", egress: "repo", scope: { repository: "sam/dotfiles" }, subject: "u_123" },
//   ],
// }

// Applied copies: the route table, with one grant per gateway, in the intercept props or the proxy.
```

```ts
yield* sandbox.start({ size, egress, ttl }); // stores, applies
yield* sandbox.setEgress({ egress: [work.model] }); // stores, applies; omitted fields are kept
yield* sandbox.start({ size }); // no egress: re-applies what's stored
yield* sandbox.stop(); // stops; the stored egress stays for the next start()
```

Every failure converges from storage:

```ts
// The Durable Object is evicted while the sandbox runs: the next alarm (≤40% of ttl) re-applies.
// The proxy restarts: its startup grants may have expired; the next alarm pushes fresh routes.
// A crash between storing and applying: the next alarm applies what's stored.
// A gateway is down at renewal: its routes keep their old grant until it expires, then fail closed.
```

## 13. Revocation

```ts
// The sandbox loses access at once, on every host:
yield* sandbox.setEgress({ egress: [work.model] }); // new, narrower grants replace the old ones
yield* sandbox.stop(); // an empty route table

// A credential stops working everywhere at once: delete or rotate it in the gateway's database.

// A grant copied out of the sandbox works until it expires: at most `ttl`.
// On Cloudflare the grants are in the intercept props, which the container can't read.
```

If `ttl` is ever too long for writes, a gateway can keep a revocation list
keyed by grant id. It still wouldn't need to know who owns the sandbox.

## 14. Measured: intercepting into a Worker, not the Durable Object

Today interception forwards every request into the owning Durable Object
(`WorkerBridge.ts` → `__alchemyEgress`). A live spike compared that with a
handler in the Worker entrypoint (one standard-4 container, 100 MB per download):

```
in the Worker entrypoint           1 download: 133 MB/s   4: 274 MB/s   8: 269 MB/s
through the Durable Object         1 download:  47 MB/s   4:  90 MB/s   8:  88 MB/s
  … with the body as an Effect Stream          34 MB/s       81 MB/s       87 MB/s

Durable Object RPC p90 while 8 downloads run (idle ≈ 45 ms)
Worker entrypoint 74 ms · through the Durable Object 221 ms · Effect Stream 307 ms
```

The entrypoint never ran in the Durable Object's isolate. The upstream was
synthetic (speed.cloudflare.com rate-limits Workers), so the Durable Object's
CPU cost is an upper bound; the throughput gap is the robust result. The relay
in section 8 adds one service-binding hop to the gateway, which runs on the
caller's thread (no public network).

## 15. Bugs this fixes in what's built

```ts
// 1. ContainerClient.ts keeps the egress set in memory only:
coordinationFor(container).liveEgress = next; // a WeakMap: gone when the Durable Object is evicted
//    - interception is lost if the Durable Object restarts while the container runs (fails closed)
//    - a repeated start({ egress }) re-applies the original set, undoing setEgress
//    Fix: section 12 (stored egress, re-applied by the alarm).

// 2. start({ egress }) skips re-intercepting when the set looks unchanged (found by the spike).
//    Fix: always apply what's stored.

// 3. makeEgressHandle buffers request bodies. Fix: stream them (a large git push).
```

## 16. Every environment

```ts
// Gateways: a declaration of named egress kinds; an effectful constructor, served on any HTTP host
export class WorkGateway extends Egress.Gateway<WorkGateway>()("WorkGateway", { model: Anthropic.Egress, repo: GitHub.Egress }) {}
Cloudflare.Worker("WorkGatewayWorker", { main }, WorkGateway.serve(implementation));
AWS.Lambda.Function("WorkGatewayLambda", { main, url: true }, WorkGateway.serve(implementation));

// Sandboxes: a declaration of sizes and accepted egress kinds
export class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large"; egress: GitHub.Egress | Anthropic.Egress }>()("Sandbox") {}

// Sandbox hosts: none of them name a gateway
Cloudflare.Containers.Sandbox(Sandbox, { main, image, sizes: { small: "basic", large: "standard-4" } }, program);
AWS.MicroVM.Sandbox(Sandbox, { main, image, sizes: { small: "4 GB", large: "32 GB" } }, program);
AWS.ECS.Sandbox(Sandbox, { main, image, sizes: { small: { cpu: 1, memory: "4 GB" }, large: { cpu: 8, memory: "32 GB" } } }, program);
Fly.Sandbox(Sandbox, { main, image, sizes: { small: "shared-cpu-2x", large: "performance-8x" } }, program);
Local.Sandbox(Sandbox, { main }, program); // alchemy dev: the same proxy

// The Durable Object: the same code on every host
const work = yield* WorkGateway;
yield* sandbox.start({ size: "large", egress: [work.model, work.repo.narrow({ repository, issue })] });
```

## 17. Pull requests

```
1. #2251 (merged)  ctx.props and ctx.exports in the Effect DX
2. alchemy/Egress  egress kinds as values with effectful constructors (GitHub, Anthropic, Http);
                   Egress.Gateway declaration + serve(effect) (mint, fetch); yield* Gateway
                   (GrantableEgress, narrow, for); Grant (WebCrypto); routes (host + path, conflicts);
                   accepted kinds on AI.Sandbox
3. Cloudflare      AlchemyEgress relay entrypoint; routes via service binding / URL; stored egress +
                   alarm renewal; bugs 1–3; drop the __alchemyEgress hop through the Durable Object
4. Hosts           harness servers yield { fetch }; Cloudflare.Containers.Sandbox(Sandbox, props, program)
                   replaces Sandbox.make; named sizes
5. AWS microVM     the bootstrap proxy; AWS.MicroVM.Sandbox
```

## 18. Open questions

1. **Hosting a gateway is a Layer, provided like the sandbox's host.** That keeps `yield* WorkGateway` host-agnostic, but means the stack must provide it. Fine, or should a gateway default to a Worker of its own?
2. **Path routing per egress:** GitHub can claim paths. GraphQL (`api.github.com/graphql`) can't be split by path, so two GitHub egresses with GraphQL on one sandbox conflict. Accept that, or route GraphQL by inspecting the query in the relay/proxy?
3. **`for(subject)`:** a separate call from `narrow`, because narrowing restricts access and the subject chooses whose credential. Name it `for`, `as`, or `on`?
4. **Certificates in the proxy:** it signs X.509 leaf certificates per host, which Node can't do natively. `@peculiar/x509` (a dependency), hand-rolled DER, or a proxy written in Go?
5. **The control port** must be reachable by the Durable Object only (a security group or private networking). Over the public internet, the control secret is the only protection.
6. **Bypassing the proxy:** tools that ignore `HTTPS_PROXY` reach the internet directly. That can't leak credentials, but it skips the rules for non-egress hosts. Closing it needs a firewall that only allows the gateways.
7. **A missed renewal:** if the Durable Object can't renew for a whole `ttl`, that gateway's routes stop working until it can. Fail closed like that, or let the proxy ask for a grant?
8. **Isolate placement on Cloudflare:** concurrent intercepted requests mostly shared one isolate (~270 MB/s). Enough for agents; worth re-measuring with a real upstream before relying on it for bulk transfer.
