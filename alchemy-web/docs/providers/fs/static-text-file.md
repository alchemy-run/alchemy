# StaticTextFile

The StaticTextFile resource creates plain text files with specified content. It's part of Alchemy's [File System (fs)](https://docs.alchemy.sh/fs) service.

# Minimal Example

Create a simple text file:

```ts
import { StaticTextFile } from "alchemy/fs";

const file = await StaticTextFile("README.md", 
  "# Project Name\n\nProject description goes here."
);
```

# Custom Path Example

Create a text file with a custom path:

```ts
import { StaticTextFile } from "alchemy/fs";

const file = await StaticTextFile("docs/README.md", "docs/README.md",
  "# Documentation\n\nThis folder contains project documentation."
);
```

# Multiline Content Example 

Create a text file with multiline content using template literals:

```ts
import { StaticTextFile } from "alchemy/fs";

const file = await StaticTextFile("CONTRIBUTING.md", `
# Contributing Guidelines

## Pull Requests
- Fork the repository
- Create a feature branch
- Submit a PR

## Code Style
- Use consistent formatting
- Add comments for complex logic
- Write unit tests
`);
```