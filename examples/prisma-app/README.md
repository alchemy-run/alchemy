# Prisma Example

This example demonstrates how to use Alchemy to create and manage Prisma projects.

## Prerequisites

Before running this example, you need:

1. A Prisma API key - Set `PRISMA_API_KEY` environment variable
2. Access to Prisma platform services

## Quick Start

1. Install dependencies:
   ```bash
   bun install
   ```

2. Deploy the project:
   ```bash
   bun run deploy
   ```

3. View the created project details in the console output.

4. Clean up resources:
   ```bash
   bun run destroy
   ```

## What This Example Does

- Creates a Prisma project with basic configuration
- Demonstrates how to set project properties like name, description, and region
- Shows how to access project information and environments
- Properly manages the lifecycle (create, update, delete) of Prisma resources

## Configuration

The example creates a project with these properties:
- **Name**: Dynamically generated with branch prefix
- **Description**: A descriptive text about the project
- **Region**: us-east-1 (configurable)
- **Private**: false (public project)

## Environment Variables

- `PRISMA_API_KEY`: Your Prisma API key (required)
- `BRANCH_PREFIX`: Optional prefix for resource names (useful for CI/CD)

## Next Steps

This basic example can be extended to:
- Create additional environments within the project
- Configure database connections
- Deploy schema changes
- Set up monitoring and logging