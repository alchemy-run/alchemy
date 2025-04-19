# AstroFile

The AstroFile resource lets you generate [Astro](https://astro.build) components using AI models. It extracts Astro code from between ```astro fences, validates the response, and formats the code with Prettier.

## Minimal Example

Generate a simple Astro component:

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate an Astro header component with a site logo and navigation menu"
});
```

## Generate Component with File Context

Use alchemy template literals to include existing files as context:

```ts
import { AstroFile } from "alchemy/ai";

const blogPost = await AstroFile("blog-post", {
  path: "./src/pages/blog/[slug].astro", 
  prompt: await alchemy`
    Create an Astro blog post page using these types:
    ${alchemy.file("src/types/Blog.ts")}
  `,
  temperature: 0.2
});
```

## Custom System Prompt

Provide a custom system prompt to guide the AI's output:

```ts
import { AstroFile } from "alchemy/ai";

const layout = await AstroFile("layout", {
  path: "./src/layouts/MainLayout.astro",
  prompt: "Create a main layout with header, footer and content slots",
  system: "You are an expert Astro developer. Create a single Astro layout file inside ```astro fences with no additional text.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```