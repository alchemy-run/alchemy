# Secrets in Alchemy

Secrets in Alchemy provide a secure way to handle sensitive data like API keys, passwords, and credentials. When stored in state files, secrets are automatically encrypted using a password, ensuring sensitive information remains protected.

## Creating Encrypted Secrets

Secrets are created using the `alchemy.secret()` function, which wraps sensitive values to ensure they're encrypted when stored in state files.

```typescript
// Create a secret from an environment variable
const apiKey = alchemy.secret(process.env.API_KEY);

// Create a secret from a string
const password = alchemy.secret("my-secure-password");

// Create a secret from an environment variable with error handling
const githubToken = await secret.env("GITHUB_TOKEN");
```

> [!NOTE]
> Secrets cannot be undefined. If you pass undefined to `alchemy.secret()`, it will throw an error.

## How Secrets are Encrypted

When a Secret is serialized to state, it's encrypted using the application or scope password. In the state file, the secret appears as an object with an `@secret` property containing the encrypted value:

```json
{
  "props": {
    "apiKey": {
      "@secret": "encrypted-value-here..."
    }
  }
}
```

## Application Scope Password

You can set a global password when initializing your Alchemy application. This password will be used for all secrets within the application scope.

```typescript
const app = alchemy("my-app", {
  stage: "prod",
  password: process.env.SECRET_PASSPHRASE
});
```

> [!TIP]
> Store your password in an environment variable rather than hardcoding it in your source code.

## Scope-Level Passwords

Different passwords can be used for different scopes, allowing for isolation of sensitive data between environments or components.

```typescript
await alchemy.run("secure-scope", {
  password: process.env.SCOPE_SECRET_PASSPHRASE
}, async () => {
  // Secrets created here will use the scope-specific password
  const dbPassword = alchemy.secret(process.env.DB_PASSWORD);
});
```

## Binding Secrets to Workers

Secrets can be bound to Cloudflare Workers, making them available at runtime without exposing them in your code.

1. Bind the Secret to the Worker
```typescript
const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    API_KEY: alchemy.secret(process.env.API_KEY),
    DATABASE_URL: alchemy.secret(process.env.DATABASE_URL)
  }
});
```

2. Access the Secret in your Worker
```typescript
export default {
  async fetch(request: Request, env: Env) {
    // Access the secret at runtime
    const apiKey = env.API_KEY;
    
    // Use the secret in your application logic
    const response = await fetch("https://api.example.com", {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    
    return response;
  }
};
```

See [/docs/concepts/bindings](/docs/concepts/bindings) for more information on bindings.

> [!NOTE]
> Without a password set in your application or scope, you cannot encrypt or decrypt secrets, and operations involving sensitive values will fail.

> [!TIP]
> For local development, you can use a simple password, but ensure you use strong, unique passwords for production environments.