# TypeScript File

The TypeScript File resource lets you generate TypeScript code files using AI models like [OpenAI GPT-4](https://openai.com/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Creates a TypeScript file with AI-generated code based on a prompt.

```ts
import { TypeScriptFile } from "alchemy/ai";

const utils = await TypeScriptFile("string-utils", {
  path: "./src/utils/string-utils.ts",
  prompt: "Generate TypeScript utility functions for string manipulation"
});
```

# Create a TypeScript File with Schema Validation

```ts
import { TypeScriptFile } from "alchemy/ai";

const userService = await TypeScriptFile("user-service", {
  path: "./src/services/UserService.ts", 
  prompt: await alchemy`
    Create a UserService class using:
    ${alchemy.file("src/types/User.ts")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  },
  prettierConfig: {
    semi: false,
    singleQuote: true
  }
});
```

# Generate a React Hook

```ts
import { TypeScriptFile } from "alchemy/ai";

const formHook = await TypeScriptFile("use-form", {
  path: "./src/hooks/useForm.ts",
  prompt: "Create a custom React hook for form state management",
  system: "You are an expert React developer. Create a single TypeScript file with proper typing.",
  model: {
    id: "claude-3-opus-20240229", 
    provider: "anthropic"
  }
});
```