---
order: 7
title: CLI Arguments
description: Learn how Alchemy automatically parses CLI arguments for common operations like destroy, read, quiet mode, and staging without requiring a traditional CLI tool.
---

# CLI Arguments

Alchemy doesn't have a traditional CLI tool like `wrangler` or `terraform` because it's designed to be an embeddable TypeScript library. Instead, it provides automatic CLI argument parsing when you initialize an alchemy application, making it easy to run your infrastructure scripts with common options.

## No CLI, but CLI Arguments

Rather than building a separate CLI tool, Alchemy automatically parses CLI arguments when you call:

```ts
const app = await alchemy("my-app");
```

This design choice keeps Alchemy simple while still providing the convenience of CLI arguments for common operations.

## Supported Arguments

### Phase Control

Control what phase your infrastructure script runs in:

```sh
# Deploy/update resources (default)
bun ./alchemy.run

# Read-only mode - doesn't modify resources
bun ./alchemy.run --read

# Destroy all resources
bun ./alchemy.run --destroy
```

Learn more about phases in the [phase concepts guide](../concepts/phase.md).

### Output Control

Control logging output:

```sh
# Quiet mode - suppress Create/Update/Delete messages  
bun ./alchemy.run --quiet
```

### Environment Control

Specify which stage/environment to target:

```sh
# Deploy to a specific stage
bun ./alchemy.run --stage production
bun ./alchemy.run --stage staging
bun ./alchemy.run --stage dev
```

By default, the stage is set to `process.env.USER` (your username). You can also use `ALCHEMY_STAGE` or `PASSWORD` environment variables to control staging behavior.

### Secret Management

Provide encryption password via environment variable:

```sh
# Set password for encrypting/decrypting secrets
ALCHEMY_PASSWORD=my-secret-key bun ./alchemy.run
```

## How It Works

When you call `alchemy("my-app")`, it automatically:

1. Parses `process.argv` for supported arguments
2. Merges CLI options with any explicit options you provide
3. Explicit options always take precedence over CLI arguments

```ts
// CLI args are parsed automatically
const app = await alchemy("my-app");

// Explicit options override CLI args
const app = await alchemy("my-app", {
  phase: "up", // This overrides --destroy or --read
  stage: "prod", // This overrides --stage
  quiet: false, // This overrides --quiet
});
```

## Environment Variables

Alchemy also supports these environment variables:

- `ALCHEMY_PASSWORD` - Password for encrypting/decrypting secrets
- `ALCHEMY_STAGE` - Default stage name
- `USER` - Fallback for stage name (uses your username)

## Complete Example

Here's how you might use CLI arguments in practice:

```ts
// alchemy.run.ts
import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("my-app");

const worker = await Worker("api", {
  script: "export default { fetch() { return new Response('Hello'); } }",
});

console.log({ url: worker.url });

await app.finalize();
```

Deploy commands:

::: code-group

```sh [Deploy]
bun ./alchemy.run
```

```sh [Deploy to Production]
bun ./alchemy.run --stage production
```

```sh [Read-only Check]
bun ./alchemy.run --read
```

```sh [Quiet Deploy]
bun ./alchemy.run --quiet
```

```sh [Destroy Everything]
bun ./alchemy.run --destroy
```

```sh [Deploy with Secrets]
ALCHEMY_PASSWORD=my-secret-key bun ./alchemy.run
```

:::

