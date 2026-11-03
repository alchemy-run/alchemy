# Page shapes

Each provider has the same kinds of page. Their shapes are fixed, so a reader
who knows one provider's docs can find their way around any other's.

## Hub

`<provider>/index.mdx`. In order:

1. **Opening: what the platform is.** One paragraph, technical, at a high level,
   and what it's known for. Optionally add a second paragraph with the platform's
   core structure (AWS: everything lives in an account and a region, and IAM
   decides what may call what).

   > Fly.io is a public cloud that runs your apps as fast-booting virtual machines, called Machines, in dozens of regions close to your users. A built-in proxy sends each request to the nearest Machine. Every app in an organization shares a private network over WireGuard…

   Never describe the package ("`@alchemy.run/fly` puts Fly in one typed
   program"). Never use trivia (see SKILL.md rules).
2. **A DAG** of a small typical app on the platform. Label edges in platform
   terms (`flycast`, `private network`, `s3:PutObject`), not Alchemy API names
   (`bindService`, `ConnectPostgres`).
3. **"A taste"**: two or three small, complete snippets that declare a resource,
   write a runtime and deploy the Stack.
4. **"Where to start"**: links to What is, Setup, the tutorial, and the main
   chapters.

## What is X?

`<provider>/what-is-<provider>.mdx`, titled "What is X?". The model is
`domain/what-is-ddd.mdx` and `aws/what-is-aws.mdx`.

1. A paragraph on what the platform is.
2. One framing line: "This page introduces the concepts you meet on X, once
   each, and how Alchemy models them. The examples follow one small app: …"
3. "Here is the whole picture…", then a DAG of that app showing the platform's
   boundaries (account, region, organization) as `groups`.
4. **One `##` per concept, in the order a newcomer meets them**: account or
   organization, access, regions, compute, storage, messaging, networking,
   observability, then state ("Alchemy's record in your account"). Each section
   bolds the term, explains it in platform terms, shows the smallest snippet
   if there is an Alchemy resource for it, and ends with a "See [chapter]" link.
5. **"How @alchemy.run/x models these concepts"**: one paragraph mapping
   concepts to resources, bindings and profiles.
6. A "Next" line pointing to the tutorial or getting started.

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
