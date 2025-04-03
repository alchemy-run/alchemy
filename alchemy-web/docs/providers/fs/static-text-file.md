# Static Text File

The Static Text File resource allows you to create and manage plain text files within your application using Alchemy IaC. This resource is part of the Alchemy file system service, which provides various utilities for file management. For more information, visit the [Alchemy website](https://alchemy.com).

# Minimal Example

```ts
import { StaticTextFile } from "alchemy/fs";

// Create a simple text file with content
const readme = await StaticTextFile("README.md", "# Project Name\n\nProject description goes here.");
```

# Create the Static Text File

```ts
import { StaticTextFile } from "alchemy/fs";

// Create a text file with a specified path and content
const notes = await StaticTextFile("notes.txt", "These are some important notes.");
```