# Text File

The Text File resource allows you to create and manage plain text files within the filesystem using Alchemy's Infrastructure-as-Code (IaC) framework. This resource is part of the Alchemy fs service, which provides various file management capabilities.

# Minimal Example

```ts twoslash
import { TextFile } from "alchemy/fs";

// Create a simple text file with content
const readme = await TextFile("README.md", "# Project Name\n\nProject description goes here.");
//     ^?
```

# Create the Text File

```ts twoslash
import { TextFile } from "alchemy/fs";

// Create a text file with specified content
const notes = await TextFile("notes.txt", "These are some important notes.");
//     ^?
```