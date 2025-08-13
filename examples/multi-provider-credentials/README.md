# Multi-Provider Scope Credentials Example

This example demonstrates Alchemy's extensible scope credential system, which allows you to configure multiple cloud providers at the scope level without modifying the core Scope interface.

## How It Works

The system uses TypeScript's module augmentation to allow each provider to extend the scope options:

### 1. Provider Extension Files

Each provider creates a scope extension file that augments the `ProviderCredentials` interface:

```typescript
// alchemy/src/aws/scope-extensions.ts
declare module "../scope.ts" {
  interface ProviderCredentials {
    aws?: AwsClientProps;
  }
}

// alchemy/src/cloudflare/scope-extensions.ts  
declare module "../scope.ts" {
  interface ProviderCredentials {
    cloudflare?: CloudflareApiOptions;
  }
}
```

### 2. Automatic Extension Loading

When you import a provider module, the scope extensions are automatically loaded:

```typescript
import { Vpc } from "alchemy/aws/ec2/vpc";        // Loads AWS scope extensions
import { Worker } from "alchemy/cloudflare/worker"; // Loads Cloudflare scope extensions
```

### 3. Usage in Scope Configuration

You can then configure multiple providers at the scope level:

```typescript
await alchemy.run("my-app", {
  // AWS credentials
  aws: {
    region: "us-west-2",
    profile: "production",
  },
  // Cloudflare credentials  
  cloudflare: {
    accountId: "abc123",
    apiToken: secret("..."),
  },
}, async () => {
  // Resources inherit scope credentials
  const vpc = await Vpc("main-vpc", { cidrBlock: "10.0.0.0/16" });
  const worker = await Worker("api-worker", { entrypoint: "./worker.ts" });
});
```

## Benefits

1. **Extensible**: New providers can add scope-level credential support without modifying core files
2. **Type-Safe**: Full TypeScript support with proper intellisense and type checking
3. **Consistent**: Same pattern across all providers
4. **Backward Compatible**: Existing code continues to work unchanged
5. **Multi-Provider**: Configure multiple providers simultaneously

## Adding New Providers

To add scope-level credential support for a new provider:

1. Create a scope extension file:
```typescript
// src/my-provider/scope-extensions.ts
declare module "../scope.ts" {
  interface ProviderCredentials {
    myProvider?: MyProviderOptions;
  }
}
```

2. Import it in your provider's index file:
```typescript
// src/my-provider/index.ts
import "./scope-extensions.ts";
// ... other exports
```

3. Use it in your provider's credential resolution:
```typescript
const currentScope = Scope.getScope();
const providerConfig = currentScope?.providerCredentials?.myProvider;
```

## Running This Example

```bash
# Install dependencies
bun install

# Run the example (requires AWS and Cloudflare credentials)
bun run alchemy.run.ts
```

Note: This example requires valid AWS and Cloudflare credentials to actually create resources.