# Create a Custom Resource with AI

## Overview

In this tutorial, you'll learn how to create a custom resource in Alchemy using AI assistance. Alchemy is a TypeScript-native Infrastructure-as-Code (IaC) library that allows you to model resources that are automatically created, updated, and deleted. By leveraging AI, you can quickly create custom resources for any API without waiting for official provider implementations.

## Prerequisites

- Basic knowledge of TypeScript
- Familiarity with async/await patterns
- An API you want to integrate with
- [Get started with Alchemy](/docs/getting-started)

## Setup

Create a new file for your Alchemy script:

```bash
touch ./alchemy.run.ts
```

## Step 1: Initialize Your Alchemy App

First, let's create a basic Alchemy application:

```typescript
import alchemy from "alchemy";

// Initialize the app with a name and stage
await using app = alchemy("my-app", {
  stage: "dev",
  password: process.env.SECRET_PASSWORD
});
```

This creates an Alchemy application with a development stage and sets up password protection for any secrets you might use.

## Step 2: Define Your Resource Interfaces

Next, define the interfaces for your custom resource. Let's create a simple example for a hypothetical "Note" API:

```typescript
// Define the input properties for your resource
interface NoteProps {
  title: string;
  content: string;
  tags?: string[];
}

// Define the output interface that extends the Resource type
interface Note extends Resource<"notes::Note"> {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}
```

These interfaces define what properties your resource accepts and what it returns after creation.

## Step 3: Implement the Resource Function

Now, implement the resource function that handles the create, update, and delete lifecycle:

```typescript
import { Resource } from "alchemy";
import { Context } from "alchemy";

const Note = Resource(
  "notes::Note",
  async function(
    this: Context<Note>,
    id: string,
    props: NoteProps
  ): Promise<Note> {
    // Get API key from environment (using alchemy.secret for security)
    const apiKey = alchemy.secret(process.env.NOTES_API_KEY);
    
    if (this.phase === "delete") {
      // Delete the resource
      await fetch(`https://api.example.com/notes/${this.output?.id}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${apiKey.unencrypted}`,
        }
      });
      return this.destroy();
    }
    
    if (this.phase === "create") {
      // Create a new note
      const response = await fetch("https://api.example.com/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey.unencrypted}`,
        },
        body: JSON.stringify({
          title: props.title,
          content: props.content,
          tags: props.tags || []
        })
      });
      
      const data = await response.json();
      
      return this({
        id: data.id,
        title: data.title,
        content: data.content,
        tags: data.tags,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      });
    }
    
    if (this.phase === "update") {
      // Update an existing note
      const response = await fetch(`https://api.example.com/notes/${this.output?.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey.unencrypted}`,
        },
        body: JSON.stringify({
          title: props.title,
          content: props.content,
          tags: props.tags || []
        })
      });
      
      const data = await response.json();
      
      return this({
        id: data.id,
        title: data.title,
        content: data.content,
        tags: data.tags,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      });
    }
    
    // This should never happen
    throw new Error("Unknown phase");
  }
);
```

This implementation handles the complete lifecycle of your resource, making API calls to create, update, or delete notes.

## Step 4: Use Your Custom Resource

Now you can use your custom resource in your Alchemy application:

```typescript
// Create a new note
const myNote = await Note("my-first-note", {
  title: "Hello Alchemy",
  content: "This is my first custom resource created with AI assistance!",
  tags: ["alchemy", "custom", "ai"]
});

console.log(`Created note with ID: ${myNote.id}`);
console.log(`Title: ${myNote.title}`);
console.log(`Created at: ${new Date(myNote.createdAt).toLocaleString()}`);
```

This creates a new note using your custom resource implementation.

## Step 5: Update Your Resource

You can update your resource by calling the same function with updated properties:

```typescript
// Update the note
const updatedNote = await Note("my-first-note", {
  title: "Updated Title",
  content: "I've updated my first custom resource!",
  tags: ["alchemy", "custom", "ai", "updated"]
});

console.log(`Updated note at: ${new Date(updatedNote.updatedAt).toLocaleString()}`);
```

Alchemy automatically detects that this is an update operation and calls your resource function with the "update" phase.

## Testing Your Work

To test your custom resource, run your Alchemy script:

```bash
bun ./alchemy.run.ts
```

You should see output showing the creation and updating of your note. Check the `.alchemy` directory to see the state files that Alchemy has created to track your resources.