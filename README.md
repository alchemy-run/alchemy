<div align="center">

<a href="https://alchemy.run">
  <img src="https://raw.githubusercontent.com/alchemy-run/alchemy/main/images/readme-hero.webp" alt="Alchemy — Infrastructure as Effects" width="360" />
</a>

<br />

[![npm](https://img.shields.io/npm/v/alchemy?style=flat-square&color=3f5a2a&label=alchemy)](https://www.npmjs.com/package/alchemy)
[![license](https://img.shields.io/badge/license-Apache%202.0-3f5a2a?style=flat-square)](./LICENSE)
[![discord](https://img.shields.io/badge/discord-join-3f5a2a?style=flat-square&logo=discord&logoColor=white)](https://alchemy.run/discord)

**The tightest feedback loop from edit to production.**

Cloud programs composed from [Effect](https://effect.website) Layers: type-checked, emulated locally, tested live, and deployed per pull request.

[Docs](https://alchemy.run) · [Getting started](https://alchemy.run/getting-started) · [Examples](./examples) · [Discord](https://alchemy.run/discord)

</div>

---

Alchemy is an Infrastructure-as-Effects framework for TypeScript. Cloud resources, the access your code has to them, and the code itself are one Effect program. Each feature is a Layer that creates its own resources, binds the access it needs, and implements a service, so the type checker can verify the whole stack before anything deploys.

```sh
pnpm add alchemy@latest effect @effect/platform-bun @effect/platform-node
```

## A feature is a Layer

A `Files` service, and a Layer that implements it on Cloudflare R2:

```typescript
export class Files extends Context.Service<
  Files,
  { upload(name: string, body: string): Effect.Effect<void, unknown, Alchemy.RuntimeContext> }
>()("Files") {}

export const FilesR2 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Files"); // resource
    const files = yield* Cloudflare.R2.ReadWriteBucket(bucket); // binding

    return {
      upload: (name, body) => files.put(name, body).pipe(Effect.asVoid), // API
    };
  }),
).pipe(Layer.provide(Cloudflare.R2.ReadWriteBucketBinding));
```

At deploy time the Layer creates the bucket and binds it to whichever Worker provides the Layer. At runtime the same code returns a typed client for that bucket.

## Provide it to a Worker, and deploy a Stack

```typescript
// src/Api.ts
export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const files = yield* Files;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        yield* files.upload(request.url, yield* request.text);
        return HttpServerResponse.empty({ status: 201 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(FilesR2)),
);
```

```typescript
// alchemy.run.ts
export default Alchemy.Stack(
  "MyApp",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
```

```sh
pnpm alchemy dev       # run the Stack on emulated services, reloading on change
pnpm alchemy plan      # show what a deploy would change
pnpm alchemy deploy    # create or update a stage (--stage <name>)
pnpm alchemy destroy   # delete everything the stage created
```

## The type checker checks the infrastructure

A Worker's type lists every service it needs, and each binding's client only has the methods its access level grants. A missing Layer or the wrong access level fails in your editor:

```typescript
const files = yield* Cloudflare.R2.ReadBucket(bucket);
files.put(name, body);
// Property 'put' does not exist on type 'ReadBucketClient'.
```

```typescript
Effect.gen(function* () {
  const files = yield* Files;
  // ...
}); // Effect.provide(FilesR2) removed
// Type 'Files' is not assignable to type 'PlatformServices | WorkerServices'.
```

Cloud API failures are typed too: every operation's errors are tagged Effect errors you can handle with `Effect.catchTag`.

## Swap a Layer to change platforms

The same `Files` service, implemented on AWS S3. Code that uses `Files` stays the same; its host provides `FilesS3` in place of `FilesR2`, and the binding grants an IAM policy for `s3:PutObject` on that bucket's objects:

```typescript
export const FilesS3 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("Files");
    const putObject = yield* AWS.S3.PutObject(bucket);

    return {
      upload: (name, body) => putObject({ Key: name, Body: body }).pipe(Effect.asVoid),
    };
  }),
).pipe(Layer.provide(AWS.S3.PutObjectHttp));
```

## Test on emulated services, then against the real cloud

One test file covers both. `LOCAL=1 pnpm test` runs the Stack on emulated services in seconds. `pnpm test` deploys it to a test stage (`test_$USER` by default), runs the same test against real resources and permissions, and destroys the stage afterwards.

```typescript
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: !!process.env.LOCAL,
});

const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

test(
  "uploads a file",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/hello.txt`).pipe(HttpClientRequest.bodyText("hi")),
    );
    expect(response.status).toBe(201);
  }),
);
```

## Deploy a preview for every pull request

The root GitHub Action deploys each pull request to its own `staging-<number>` stage, destroys that stage when the pull request closes, and deploys `main` to `prod`. During pull requests it sets `PULL_REQUEST`, so a Stack can add PR-only resources such as a `GitHub.Comment` with the preview URL.

```yaml
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # install your dependencies and put the `alchemy` CLI on PATH here
      - uses: alchemy-run/alchemy@main
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

See the [CI guide](https://alchemy.run/environments/ci) to write the workflow by hand.

## Providers

| Category | Providers |
| --- | --- |
| Compute and hosting | [Cloudflare](https://alchemy.run/cloudflare) · [AWS](https://alchemy.run/aws) · [GCP](https://alchemy.run/gcp) · [Kubernetes](https://alchemy.run/kubernetes) · [Fly](https://alchemy.run/fly) · [Railway](https://alchemy.run/railway) · [Hetzner](https://alchemy.run/hetzner) · [Docker](https://alchemy.run/docker) |
| Databases | [Neon](https://alchemy.run/neon) · [PlanetScale](https://alchemy.run/planetscale) · [Prisma](https://alchemy.run/prisma) · [SQL and Drizzle](https://alchemy.run/sql) |
| Services | [GitHub](https://alchemy.run/github) · [Stripe](https://alchemy.run/stripe) · [Axiom](https://alchemy.run/axiom) · [Better Auth](https://alchemy.run/better-auth) |
| Secrets | [Doppler](https://alchemy.run/environments/doppler) · [Infisical](https://alchemy.run/environments/infisical) |

Websites built with Astro, Next.js, Nuxt, React Router, SolidStart, SvelteKit, TanStack Start, Vite and more deploy to Cloudflare, AWS, GCP, Fly, Railway, Hetzner, Neon and Prisma. The [examples](./examples) folder has a runnable project for most combinations.

## Using a coding agent

Docs are indexed for agents at [alchemy.run/llms.txt](https://alchemy.run/llms.txt). A starting prompt:

```
Help me build an Alchemy app. Read https://alchemy.run/getting-started and follow
it to create an `alchemy.run.ts` Stack, then ask me what I want to build.
Use https://alchemy.run/llms.txt to find the docs you need instead of guessing URLs.
Confirm with me before each deploy.
```

The home page has the [full prompt](https://alchemy.run/#agent-prompt).

## Learn more

- [What is Alchemy?](https://alchemy.run/what-is-alchemy): the model in a few minutes
- [Getting started](https://alchemy.run/getting-started): your first Stack
- Tutorials for [Cloudflare](https://alchemy.run/cloudflare/tutorial/part-1) and [AWS](https://alchemy.run/aws/tutorial/part-1): from the first resource to tests, local dev, and CI previews
- [Testing](https://alchemy.run/testing): the test harness, emulated and live
- [Migrating from v1](https://alchemy.run/migrating-from-v1): moving from the async/await API

> Alchemy 2 is in beta (`2.0.0-beta.x`). Expect breaking changes between betas. Come hang out in our [Discord](https://alchemy.run/discord).

## Credits

### Blacksmith

Thanks to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for sponsoring our CI runners. Their fast Linux, macOS, and Windows runners help us test our packages across platforms and deploy our content-heavy website in mere minutes.

## License

Licensed under the [Apache License 2.0](./LICENSE). See
[Third-Party Licenses](./THIRD_PARTY_LICENSES.md) for code incorporated from
upstream projects.
