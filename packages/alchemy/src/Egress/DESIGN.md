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

Nothing is fixed at build time. The Durable Object stores what it granted and
pushes a route table (which host and path go to which gateway) to the
sandbox's host. Each gateway signs short-lived **grants** for its egresses,
renewed before they expire: on Cloudflare by the relay that forwards the
container's requests, anywhere else by the Durable Object. Only the transport
differs by host: a Cloudflare Container reaches a gateway over a native Worker
binding, anything else through a proxy in the sandbox over HTTPS.

```
                     Durable Object that owns the sandbox
                       stores the egresses it granted (and ttl)
                       Cloudflare: the relay mints grants; elsewhere: it renews them
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
>()("Sandbox", { egress: [GitHub.Egress, Anthropic.Egress] }) {}
```

The accepted kinds are also passed as values, because their tools ship with
them: each host installs the tools for the accepted kinds at deploy (`git`
and `gh` for `GitHub.Egress`). Declaring `egress` in the type without the
values doesn't compile. `start` sets the placeholder credentials
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
    sizes: { small: "lite", large: "standard-4" },
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
import { Sandbox } from "./Sandbox.ts";

export default AWS.Lambda.MicrovmSandbox(
  Sandbox,
  {
    main: import.meta.url,
    // One microVM image per name, built at deploy; start() picks the image.
    sizes: { small: "2 GB", large: "8 GB" },
  },
  Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
```

Sizes are named, not measured, because hosts size differently. A Cloudflare
Container picks its instance type at `start()`. A Lambda microVM's memory is
fixed on its image (`CreateMicrovmImage.resources`; `RunMicrovm` has no size),
so each size is its own image. Each host maps every declared name; a missing
or extra name doesn't compile:

```ts
AWS.Lambda.MicrovmSandbox(Sandbox, { main, sizes: { small: "2 GB" } }, program);
// ✗ Property 'large' is missing in type '{ small: "2 GB" }'
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
its own Worker's `AlchemyEgress` entrypoint (#2251's `ctx.exports`). The props
carry the host's routes and what was granted, never a grant. The relay runs in
the Worker, never in the Durable Object, and the container can't see the props:

```ts
// what one host is intercepted with
interface RelayProps {
  readonly routes: ReadonlyArray<{ host: string; paths?: ReadonlyArray<string>; gateway: { id: string; url: string } }>;
  readonly egress: { readonly [gatewayId: string]: ReadonlyArray<EgressRef> }; // each routed gateway's whole grant
  readonly ttl: number;
}
```

```ts
// alchemy internal: Cloudflare/Containers/Egress.ts — in the owning Durable Object
const applyHosts = (hosts: Record<string, RelayProps>, previous: Record<string, RelayProps>) =>
  Effect.gen(function* () {
    const ctx = yield* Cloudflare.DurableObjectState;
    for (const [host, props] of Object.entries(hosts)) {
      if (canonicalJson(props) === canonicalJson(previous[host])) continue; // unchanged: left alone
      yield* container.interceptOutboundHttps(host, yield* ctx.exports.AlchemyEgress({ props }));
    }
    for (const host of Object.keys(previous).filter((host) => !(host in hosts))) {
      yield* container.interceptOutboundHttps(host, yield* ctx.exports.AlchemyEgress({ props: { routes: [] } }));
    }
  });
```

The relay mints each gateway's grant itself, over the gateway's service
binding (`ALCHEMY_EGRESS_<id>`, bound into the Durable Object's Worker by
`yield* Gateway`). Grants are cached per isolate by gateway, refs and ttl, and
minted again once they are within 40% of their lifetime of expiring. A request
keeps the grant it started with, so a long transfer outlives any number of
expiries:

```ts
// alchemy internal: Cloudflare/Containers/EgressRelay.ts — the generated Worker entry exports it
const grants = new Map<string, { grant: string; expires: number; renewAt: number }>(); // plain values
const minting = new Map<string, Promise<CachedGrant>>(); // concurrent requests mint once

export class AlchemyEgress extends WorkerEntrypoint {
  async fetch(request: Request) {
    const { routes, egress, ttl } = this.ctx.props as RelayProps;
    const route = mostSpecific(routes, new URL(request.url).pathname);
    if (!route) return fetch(request); // not an egress request: straight out
    const gateway = this.env[`ALCHEMY_EGRESS_${route.gateway.id}`] as Fetcher;
    const key = `${route.gateway.id} ${ttl} ${canonicalJson(egress[route.gateway.id])}`;
    const cached = grants.get(key);
    const grant =
      cached && Date.now() < cached.renewAt
        ? cached.grant
        : await mintOnce(key, () => gateway.mint(egress[route.gateway.id], ttl)); // shares a mint in flight
    return gateway.fetch(route.gateway.url, toGatewayRequest(request, grant)); // Authorization: Macaroon
  }
}
```

A mint another request started is awaited for at most 10 seconds (its I/O
belongs to that request), then the waiter mints its own.

An intercept is re-registered only when its host's props change: `start` with
different egress, `setEgress`, `stop`. Re-registering can reset a TLS
handshake in flight (measured: 2 of 24 `git ls-remote`s when every renewal
re-registered), so renewal never does it, and a host whose routes and granted
egress are unchanged keeps its intercept through `setEgress`.

Routes intercept HTTPS only; a host the Durable Object answers itself (the
harness's shutdown hook) is intercepted on HTTP and HTTPS, with
`{ control: { className, id, key } }` as its props.

### Anywhere else: a proxy in the sandbox

The image gets the proxy and the accepted kinds' tools at deploy time. No
gateways, routes or placeholders: those arrive at run time.

```ts
// alchemy internal: AWS/Lambda/MicrovmSandbox.ts, at deploy: one image per size
MicrovmImage(`${id}-${size}`, {
  imageLayers: Sandbox.egress.flatMap((kind) => kind.tools), // GitHub.Egress: git, gh
  resources: [{ minimumMemoryInMiB: sizes[size] * 1024 }],
  env: { ALCHEMY_EGRESS_PROXY: "1", ALCHEMY_EGRESS_RUN_HOOK: "1" }, // the bootstrap starts the proxy
  hooks: { port: 3129, microvmHooks: { run: "ENABLED" }, microvmImageHooks: { ready: "ENABLED" } },
});
```

A MicroVM resumes from a snapshot taken at build time: the bootstrap and the
proxy are already running, and `RunMicrovm` takes no env. So everything
per-run arrives in the `/run` lifecycle hook's payload (`runHookPayload`,
4,096 characters), answered on the proxy's control port:

```ts
// at start, for the egresses granted
runHookPayload: JSON.stringify({
  secret, // authenticates PUT /routes from now on
  routes, // the first table (pushed after RUNNING when it doesn't fit)
  env: { ...placeholdersOf(granted), ...options.env }, // GH_TOKEN=alchemy-egress
}),
```

The proxy's CA is per-run too. Minted at boot, it would be in the snapshot:
every MicroVM of the image would share its private key and its cached
leaves. So on a MicroVM the proxy starts with no CA and no routes (it
decrypts nothing; a routed host before `/run` is refused, never sent out
with its placeholder), and the trust bundle holds the system roots alone.
The `/run` hook mints this MicroVM's CA, rewrites the bundle at the same
path (so `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` set at
boot stay valid), installs it in the proxy (terminators for an older CA
are closed), and only then applies the first route table:

```ts
// alchemy internal: Runtime/Bootstrap/EgressProxy.ts, the run hook
const ca = yield* makeLocalCa; // this MicroVM's own
yield* writeTrustBundle(EGRESS_PROXY_CA_BUNDLE, [ca.pem]); // same path, renamed over
yield* proxy.useCa(ca);
yield* SubscriptionRef.set(routes, config.routes);
```

Who trusts it: each program reads the bundle at its own start. The program
(the bootstrap's own process) starts before `/run`, but it never trusted the
bundle: `NODE_EXTRA_CA_CERTS` is read at process start and is set only
afterwards. git, gh and a harness CLI are children it spawns per request,
after `/run` (their placeholder credentials arrive there), so they read the
new bundle. A child spawned before `/run` trusts the system roots alone, and
fails closed on a routed host.

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

The Durable Object stores what it granted and applies it to its host. Hosts
differ in who renews grants: on Cloudflare the relay mints and renews them
itself (section 8), so the Durable Object never renews and holds no alarm.
Anywhere else the proxy in the sandbox can't mint, so the Durable Object
renews and pushes (`host.renews`).

```ts
// alchemy internal: shared by every host, runs in the owning Durable Object
interface EgressState {
  readonly ttl: Duration.Duration;
  readonly egress: ReadonlyArray<EgressRef>; // each names its gateway
  readonly hosts: Record<string, RelayProps>; // what each host is intercepted with (Cloudflare)
}

/** One mint per gateway: checks scopes, resolves dynamic routes, finds conflicts. */
const routes = (s: EgressState) =>
  Effect.gen(function* () {
    const table: Route[] = [];
    for (const [gatewayId, refs] of groupByGateway(s.egress)) {
      const minted = yield* gatewayClient(gatewayId).mint(refs, s.ttl);
      for (const ref of refs) table.push(...routesOf(ref, minted));
    }
    return yield* checkConflicts(table); // EgressRouteConflict
  });

start: ({ size, egress, ttl }) =>
  Effect.gen(function* () {
    const stored = yield* load;
    const next = merge(stored, { egress, ttl }); // omitted fields are kept
    if (yield* host.running) {
      if (same(stored, next)) return; // already applied: no mint, no intercept
      return yield* host.apply(next, yield* routes(next)); // only changed hosts
    }
    const table = yield* routes(next); // conflicts fail start before anything is stored
    yield* host.apply(next, table, { fresh: true }); // before the program runs
    yield* host.launch({ size, routes: table });
    if (host.renews) yield* scheduleRenewal(next.ttl);
  }),

setEgress: ({ egress, ttl }) =>
  Effect.gen(function* () {
    const next = merge(yield* load, { egress, ttl });
    yield* host.apply(next, yield* routes(next)); // stores; only changed hosts
  }),

stop: () =>
  host.clear().pipe( // refuses every routed host; the stored egress stays
    Effect.andThen(host.stop()),
  ),
```

On Cloudflare, `apply` diffs each host's props against what's stored and
re-intercepts only the ones that differ (section 8), then stores the new
props. A Durable Object constructed while its container still runs (evicted,
aborted, redeployed) re-registers the stored props once, with no mint: an
intercept registered by the previous instance doesn't survive it intact
(measured: after `ctx.abort()`, new connections to `github.com` were reset
during the TLS handshake until the new instance re-registered).

The microVM host renews: an `Alchemy.makeCallback` job on the Durable Object's
alarm re-mints at 40% of the TTL and pushes a fresh table to the proxy's
control port. The Durable Object reaches the MicroVM's ports through its
endpoint: a `CreateMicrovmAuthToken` token scoped to one port
(`X-aws-proxy-auth`) and `X-aws-proxy-port`; pushes to the control port also
carry the bearer secret it generated at `start` and stored.

```ts
// alchemy internal: AWS/Lambda/MicrovmSandboxClient.ts — the microVM host
launch: ({ size, routes }) =>
  Effect.gen(function* () {
    const secret = randomSecret();
    const vm = yield* runMicrovm[size]({ // one image per declared size, built at deploy
      runHookPayload: JSON.stringify({ secret, routes, env: placeholders }),
      egressNetworkConnectors: [INTERNET_EGRESS],
    });
    yield* state.storage.put("alchemy:egress:Sandbox", { ttl, egress, microvm: { ...vm, secret } });
  }),

apply: (routes) =>
  HttpClient.put(`https://${vm.endpoint}/routes`, {
    body: JSON.stringify(routes),
    headers: {
      ...authToken(vm, 3129), // X-aws-proxy-auth, scoped to the control port
      "X-aws-proxy-port": "3129",
      authorization: `Bearer ${secret}`,
    },
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
yield* state.storage.get("alchemy:egress");
// {
//   ttl: 300000,
//   egress: [
//     { gateway: "WorkGateway", egress: "model" },
//     { gateway: "WorkGateway", egress: "repo", scope: { repository: "alchemy-run/alchemy", issue: 42 } },
//     { gateway: "UserGateway", egress: "repo", scope: { repository: "sam/dotfiles" }, subject: "u_123" },
//   ],
//   hosts: { // Cloudflare: what each host is intercepted with; {} while stopped
//     "github.com": { routes: [/* Work's and User's paths */], egress: { WorkGateway: [...], UserGateway: [...] }, ttl: 300000 },
//     "api.anthropic.com": { routes: [/* the whole host */], egress: { WorkGateway: [...] }, ttl: 300000 },
//   },
// }

// Minted grants, never stored: on Cloudflare in the relay's isolate cache (plain strings, until
// they near expiry); elsewhere in the proxy's route table, pushed by the Durable Object.
```

```ts
yield* sandbox.start({ size, egress, ttl }); // applies the changed hosts, stores
yield* sandbox.setEgress({ egress: [work.model] }); // the same; omitted fields are kept
yield* sandbox.start({ size }); // running: nothing to do; stopped: applies what's stored
yield* sandbox.stop(); // refuses the routed hosts, stops; the stored egress stays for the next start()
```

Every failure converges from storage:

```ts
// Cloudflare
// The Durable Object restarts while the sandbox runs: its new instance re-registers the stored hosts once.
// A crash while applying: nothing new is stored, so the next start/setEgress re-diffs against the old hosts.
// A gateway can't mint: the relay keeps a cached grant until it expires, then answers 502 (fail closed).

// Elsewhere
// The proxy restarts: its startup grants may have expired; the next renewal pushes fresh routes.
// A gateway is down at renewal: its routes keep their old grant until it expires, then fail closed.
```

## 13. Revocation

```ts
// The sandbox loses access at once, on every host:
yield* sandbox.setEgress({ egress: [work.model] }); // changed hosts get new props: narrower grants from the next request
yield* sandbox.stop(); // every routed host refused

// A credential stops working everywhere at once: delete or rotate it in the gateway's database.

// A grant copied out of the sandbox works until it expires: at most `ttl`.
// On Cloudflare grants never enter the sandbox or the props: the relay mints them in the Worker.
```

On Cloudflare a request already in flight when its host is re-intercepted
keeps the grant it started with; requests after it mint for the new props
(the cache key includes the granted refs, so a narrower grant is never
served from an older, wider one).

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
//    Fix: section 12 (stored egress and hosts, re-registered on construction).

// 2. start({ egress }) skips re-intercepting when the set looks unchanged (found by the spike).
//    Fix: always apply what's stored.

// 3. makeEgressHandle buffers request bodies. Fix: stream them (a large git push).
```

Fixed in PR 3: the egress is stored in the Durable Object (`alchemy:egress`)
with the props each host is intercepted with, and re-registered once on
construction when the container is already running; `start` converges on the
asked-for egress by diffing hosts (unchanged hosts are untouched); the relay
mints and renews grants itself; the relay and the gateway stream bodies.
`makeEgressHandle`, `Cloudflare.Containers.Egress` and the `__alchemyEgress`
hop are gone. The one host a Durable Object still answers itself is the
harness's shutdown hook (`alchemy.internal`), through the same relay
(`props.control`).

## 16. Every environment

```ts
// Gateways: a declaration of named egress kinds; an effectful constructor, served on any HTTP host
export class WorkGateway extends Egress.Gateway<WorkGateway>()("WorkGateway", { model: Anthropic.Egress, repo: GitHub.Egress }) {}
Cloudflare.Worker("WorkGatewayWorker", { main }, WorkGateway.serve(implementation));
AWS.Lambda.Function("WorkGatewayLambda", { main, url: true }, WorkGateway.serve(implementation));

// Sandboxes: a declaration of sizes and accepted egress kinds
export class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large"; egress: GitHub.Egress | Anthropic.Egress }>()(
  "Sandbox",
  { egress: [GitHub.Egress, Anthropic.Egress] }, // the kinds as values: hosts install their tools
) {}

// Sandbox hosts (built): none of them name a gateway
Cloudflare.Containers.Sandbox(Sandbox, { main, image, sizes: { small: "lite", large: "standard-4" } }, program);
AWS.Lambda.MicrovmSandbox(Sandbox, { main, sizes: { small: "2 GB", large: "8 GB" }, networkConnector }, program);

// Not built: further hosts would reuse the proxy, the run payload and Durable Object renewal;
// only how the sandbox starts (and how its control port is reached) differs.
AWS.ECS.Sandbox(Sandbox, { main, image, sizes: { small: { cpu: 1, memory: "4 GB" }, large: { cpu: 8, memory: "32 GB" } } }, program);
Fly.Sandbox(Sandbox, { main, image, sizes: { small: "shared-cpu-2x", large: "performance-8x" } }, program);

// The Durable Object: the same code on every host
const work = yield* WorkGateway;
yield* sandbox.start({ size: "large", egress: [work.model, work.repo.narrow({ repository, issue })] });
```

## 17. What's built (PR #2019)

```
1. #2251 (merged)  ctx.props and ctx.exports in the Effect DX
2. alchemy/Egress  egress kinds as values with effectful constructors (GitHub, Anthropic, Http);
                   Egress.Gateway declaration + serve(effect) (mint, fetch); yield* Gateway
                   (narrow, for); Grant (WebCrypto); routes (host + path, conflicts);
                   accepted kinds on AI.Sandbox; gateways on a Worker or on AWS Lambda
3. Cloudflare      AlchemyEgress relay entrypoint (mints grants lazily over the gateway's binding);
                   stored egress + per-host intercept diff; bugs 1–3; no hop through the Durable Object
4. Hosts           harness servers yield { fetch }; Cloudflare.Containers.Sandbox(Sandbox, props, program)
                   replaces Sandbox.make; named sizes
5. AWS microVM     the bootstrap proxy (run hook, a CA per MicroVM); AWS.Lambda.MicrovmSandbox;
                   renewal on the Durable Object's alarm; enableInternet; networkConnector
```

## 18. Decisions

1. **Hosting a gateway is a Layer** (`WorkGateway.host(worker)`), provided like the sandbox's host. A stack that doesn't provide one doesn't type-check.
2. **GraphQL:** `api.github.com/graphql` can't be split by path, so two GitHub egresses that both allow GraphQL on one sandbox fail `start` with `EgressRouteConflict`. Grant one of them with `graphql: false`.
3. **`for(subject)`** is separate from `narrow`: narrowing restricts access; the subject chooses whose credential. It's on every egress; the gateway refuses `for()` on a single-credential egress and requires it on a per-subject one.
4. **Certificates:** `@peculiar/x509` on WebCrypto, bundled into the image's bootstrap only. Each MicroVM mints its own CA in the `/run` hook (the image snapshot holds none).
5. **The control port** sits behind AWS's MicroVM endpoint auth (a token the Durable Object mints per port) and a bearer secret generated at `start`; only the first `/run` call is accepted.
6. **Bypassing the proxy:** with egress, `start` defaults to `enableInternet: false`, and the proxy refuses hosts without a route. A tool that ignores `HTTPS_PROXY` could still go direct: a MicroVM runs without `CAP_NET_ADMIN` (measured: Docker's default capability set), so it can't firewall itself. Closing that is network-level: `AWS.Lambda.MicrovmSandbox(..., { networkConnector })` with a VPC whose egress only reaches the gateways. On Cloudflare, `enableInternet: false` is enforced by the container runtime.
7. **A missed renewal fails closed:** if the Durable Object can't renew a MicroVM's grants for a whole `ttl`, that gateway's routes stop working until it can. On Cloudflare the relay mints its own grants, so nothing renews.
8. **Isolate placement on Cloudflare:** concurrent intercepted requests mostly share one isolate (~270 MB/s, section 14). Enough for agents.
9. **WebSocket RPC clients ping with room to spare:** effect@4.0.4's client checks its ping timeout (one 5s interval) before its first ping, so a call quiet for 5s (a `start` cloning a repository) drops a healthy socket. `Cloudflare.RpcWebSocketClient` defaults `pingTimeout` to 15s.
