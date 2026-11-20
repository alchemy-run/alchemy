# Page shapes

Each provider has the same kinds of page. Their shapes are fixed, so a reader
who knows one provider's docs can find their way around any other's.

## Hub

`<provider>/index.mdx`. The hub answers two questions: what does building on
this platform with Alchemy feel like, and where do I go next? It never explains
the platform's concepts. That's the What is page's job, and it is the only page
that draws the platform. The hub has no diagram.

Every hub has the same five parts, in order:

1. **One paragraph on what the platform is**, technical and at a high level,
   and what it's known for. A second paragraph is fine when it adds what the
   platform offers (Cloudflare's Workers and Durable Objects), never its
   structure (accounts, regions, projects, IAM).

   > Fly.io is a public cloud that runs your apps as fast-booting virtual machines, called Machines, in dozens of regions close to your users. A built-in proxy sends each request to the nearest Machine. Every app in an organization shares a private network over WireGuard…

   Never describe the package ("`@alchemy.run/fly` puts Fly in one typed
   program"). Never use trivia (see SKILL.md rules).
2. **The What is link**, right after the intro, on its own line:
   "**New to X?** Start with [What is X?](/x/what-is-x)." Nothing more: the
   page title says what it is.
3. **`## A quick example`**: two or three small, complete snippets that declare a
   resource, write a runtime and deploy the Stack, each led by one line.
   Lead-in lines, not headings.
4. **`## Where to start`**: two bold lead-ins, one line each:
   - **Want to build?** Setup, then the tutorial (or the main guide when there's
     no tutorial).
   - **Looking for something specific?** "Every section of these docs is listed
     below, and every resource is in the generated [API reference](/providers)."
5. **`## The docs`** with `<HubMap />` (import it from
   `../../../components/HubMap.astro`). It draws one card per sidebar section
   from the sidebar itself, so it never needs editing. Don't write a prose list
   of chapter links.

## What is X?

`<provider>/what-is-<provider>.mdx`, titled "What is X?". The model is
`domain/what-is-ddd.mdx` and `aws/what-is-aws.mdx`.

1. **A paragraph on the platform's model**: how its pieces fit, in its own
   terms (AWS: each service creates resources in your account, and IAM checks
   every call). It may overlap the hub's introduction; never write a sentence
   about the page instead.
2. **The example app and the whole picture, in one paragraph**: "Take one small
   app: a Lambda Function that stores files in an S3 Bucket… Your profile signs
   you in to an account…", then a DAG of that app showing the platform's
   boundaries (account, region, organization) as `groups`. Never a `Sequence`:
   the What is figure shows the pieces and where they live (`DAG`, `Tree`,
   `Boundaries`, `Shell`), and a protocol's order belongs on the chapter that
   teaches it.
3. **One `##` per concept, in the order a newcomer meets them**: account or
   organization, access, regions, compute, storage, messaging, networking,
   observability, then state ("Alchemy's record in your account"). Each section
   bolds the term, explains it in platform terms, shows the smallest snippet
   if there is an Alchemy resource for it, and ends with a "See [chapter]" link.
4. **"How @alchemy.run/x models these concepts"**: one paragraph mapping
   concepts to resources, bindings and profiles.
5. A "Next" line pointing to the tutorial or getting started.

The examples are illustrative. Don't claim they match a tutorial unless you
checked.

## Accounts & access

The first sidebar group after the tutorial (after Setup when there's no
tutorial). It holds the provider's account or organization page, plus every
page about who can do what: IAM, tokens, database credentials, secrets, Access
or federated identity.

The account page (`accounts-and-regions`, `organizations-and-tokens`,
`workspaces-and-tokens`, `accounts-and-keys`, `projects-and-regions`, …) has
these sections:

1. **What holds everything**: the account, organization, workspace or project,
   and that it's an isolation and billing boundary.
2. **Sign in with a profile**: `alchemy profile edit --add <Provider>`, each
   method, and who it's for. Put the simplest method for most readers first.
3. **One profile per account or environment**: the stage decides what is
   deployed, the profile decides where it goes. Show
   `alchemy profile create prod`, then `alchemy deploy --stage prod --profile prod`.
4. **Access narrower than yours**: tokens, roles or keys the Stack creates
   (`Cloudflare.ApiToken.AccountApiToken`, `Axiom.ApiToken`,
   `Stripe.RestrictedApiKey`), and what runtimes get automatically.
5. **In CI**: the exact environment variables read when `CI=true`, from the
   provider's setup page or `AuthProvider.ts`, and a link to `/environments/ci`.
6. A link to the provider's secrets page.

## Secrets pages

Every secrets page has a "Values from a secrets manager" section after its
`.env` section. It says `.env` is only the default, and shows a whole
`alchemy.run.ts` for that provider choosing a source per stage:

```typescript
secrets: ({ stage }) =>
  stage === "prod"
    ? Doppler.Secrets({ project: "my-app", config: "prd" })
    : Alchemy.Secrets.DotEnv(),
```

Then it says the `Config.Redacted(...)` code doesn't change, and links
[Secret providers](/environments/secret-providers).

## Choosing a runtime

Every provider with more than one place to run code gets this page, in the same
shape, so readers comparing AWS and GCP see the same thing. GCP once had a
single timeline covering three of its runtimes, and was called out as
inconsistent with AWS.

1. The intro: what the runtimes have in common.
2. A `Responsibility` matrix straight after it: one column per runtime, ordered
   from most managed to least. The rows are the same everywhere (your program,
   image or runtime, scaling, orchestration, OS & patching, hardware), and the
   caption says "From left to right, <platform> manages less and you decide
   more."
3. "The same program on every runtime", with the shared declaration.
4. One section per runtime, each with **one small diagram of how that runtime
   runs**. Draw environments for per-invocation functions, one environment with
   requests side by side for HTTP servers, always-on tasks against sparse
   traffic for containers, an execution's tasks for jobs, nodes holding Pods for
   Kubernetes, and specs inside the box for a machine. Keep them small: two or
   three lanes or boxes.
5. "Mix runtimes in one app": one diagram of a common combination.

Examples: `aws/compute/choosing-a-runtime`, `gcp/compute/choosing-a-runtime`.

## Concept chapters

One page per platform concept (Lambda, S3, KV, Machines, Branches). Open with
what the thing is on the platform, a paragraph before any code. Then build it
up: the smallest declaration first, then one capability per `##` heading, each
with its snippet: bind it, read it from a runtime, configure the common options.
End with the limits and gotchas the reader will actually hit, and links.

Cover choices neutrally. A "Choosing a runtime" page compares options by what
each is good at. It never names a house default.

## Setup

Prerequisites, install (`<PackageManagers add={pkgs} />`), creating the
platform account, connecting a profile (methods in recommended order), and the
CI variables. The prerequisites list starts with
"[Node.js](https://nodejs.org) 24.11.1+ or [Bun](https://bun.sh)".
