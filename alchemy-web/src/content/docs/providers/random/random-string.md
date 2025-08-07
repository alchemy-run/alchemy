---
title: RandomString
description: Learn how to generate cryptographically secure random strings for API keys, tokens, and passwords using Alchemy.
---

The RandomString resource generates cryptographically secure random strings that can be used for API keys, tokens, passwords, or other security-sensitive values. 

## Minimal Example

Generate a default random string (32 bytes, hex encoded):

```ts
import { RandomString } from "alchemy/random";

const apiKey = await RandomString("api-key");
// Result: 64 character hex string (e.g., "a1b2c3d4...")
```

## Verification Codes

Generate shorter random strings for verification codes:

```ts
import { RandomString } from "alchemy/random";

const verificationCode = await RandomString("email-verification", {
  length: 8,
  encoding: "hex"
});
// Result: 16 character hex string
```

## Session Tokens

Create base64-encoded random strings for session tokens:

```ts
import { RandomString } from "alchemy/random";

const sessionToken = await RandomString("session-token", {
  length: 48,
  encoding: "base64"
});
// Result: ~64 character base64 string
```

## Integration with Other Resources

Use RandomString to generate secure passwords for databases and other resources:

```ts
import { RandomString } from "alchemy/random";
import { PostgresDatabase } from "alchemy/neon";

const dbPassword = await RandomString("db-password", { 
  length: 32 
});

const database = await PostgresDatabase("mydb", {
  name: "production",
  password: dbPassword.value
});
```

## Multiple Secrets

Generate multiple unique secrets for different purposes:

```ts
import { RandomString } from "alchemy/random";

// JWT signing secret
const jwtSecret = await RandomString("jwt-secret", { 
  length: 64 
});

// Encryption key
const encryptionKey = await RandomString("encryption-key", {
  length: 32,
  encoding: "base64"
});

// API key
const apiKey = await RandomString("api-key", {
  length: 32,
  encoding: "hex"
});
```

## Understanding Length and Encoding

The `length` parameter specifies the number of random **bytes** to generate, not the final string length:

- **Hex encoding**: Produces 2 characters per byte
  - 32 bytes → 64 character string
  - 16 bytes → 32 character string
  
- **Base64 encoding**: Produces approximately 1.33 characters per byte
  - 32 bytes → ~43 character string
  - 48 bytes → ~64 character string

Choose your encoding based on your use case:
- **Hex**: Use for API keys, tokens, and when you need URL-safe strings
- **Base64**: Use when you need more entropy in fewer characters

## State Management

RandomString resources maintain their state between deployments. If you update a RandomString with the same `length` and `encoding`, it will return the existing value rather than generating a new one. This ensures:

- API keys remain stable across deployments
- Database passwords don't change unexpectedly
- Session secrets maintain continuity

To force regeneration of a secret, either:
1. Change the resource ID
2. Delete and recreate the resource
3. Change the `length` or `encoding` parameters

## Security Considerations

- Values are generated using Node.js `crypto.randomBytes()` which provides cryptographically strong pseudo-random data
- All generated values are automatically wrapped with `alchemy.secret()` to prevent accidental exposure
- Values are encrypted at rest in the Alchemy state store
- Never log or print the `.value` property directly - use Alchemy's secret handling mechanisms

## Example: Complete Authentication Setup

```ts
import { RandomString } from "alchemy/random";
import { Worker } from "alchemy/cloudflare";
import { PostgresDatabase } from "alchemy/neon";

// Generate all required secrets
const jwtSecret = await RandomString("jwt-secret", { length: 64 });
const sessionSecret = await RandomString("session-secret", { length: 32 });
const dbPassword = await RandomString("db-password");

// Create database with secure password
const database = await PostgresDatabase("auth-db", {
  name: "authentication",
  password: dbPassword.value
});

// Create worker with secrets as environment variables
const authWorker = await Worker("auth-api", {
  entrypoint: "./src/auth.ts",
  bindings: {
    JWT_SECRET: jwtSecret.value,
    SESSION_SECRET: sessionSecret.value,
    DATABASE_URL: database.connectionUrl
  }
});
```