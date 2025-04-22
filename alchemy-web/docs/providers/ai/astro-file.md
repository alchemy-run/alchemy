# AstroFile

The AstroFile resource lets you generate [Astro](https://astro.build/) components and pages using AI models.

# Minimal Example

Creates a basic Astro component with AI-generated code.

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate an Astro header component with a logo, navigation menu, and mobile responsiveness"
});
```

# Generate with File Context

Uses existing files as context for generating components.

```ts
import { AstroFile } from "alchemy/ai";

const blogPost = await AstroFile("blog-post", {
  path: "./src/pages/blog/[slug].astro",
  prompt: await alchemy`
    Create an Astro blog post page using:
    ${alchemy.file("src/types/Blog.ts")}
  `,
  temperature: 0.2
});
```

# Custom System Prompt

Provides specific instructions to the AI model.

```ts
import { AstroFile } from "alchemy/ai";

const layout = await AstroFile("layout", {
  path: "./src/layouts/MainLayout.astro",
  prompt: "Create a main layout with SEO metadata and content slots",
  system: "You are an expert Astro developer. Create a single Astro layout file with proper typing and best practices.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```