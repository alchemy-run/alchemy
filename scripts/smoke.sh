#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Get the root directory of the script
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
EXAMPLES_DIR="$ROOT_DIR/examples"

if [ ! -d "$EXAMPLES_DIR" ]; then
  echo "Error: Directory '$EXAMPLES_DIR' does not exist."
  exit 1
fi

echo "Running smoke tests..."

# Loop through each subdirectory in the examples directory
for dir in "$EXAMPLES_DIR"/*/; do
  if [ -d "$dir" ]; then
    EXAMPLE_NAME=$(basename "$dir")

    # Skip the aws-app directory
    if [ "$EXAMPLE_NAME" = "aws-app" ]; then
      echo "--- Skipping: $EXAMPLE_NAME ---"
      echo ""
      continue
    fi

    echo "--- Processing: $EXAMPLE_NAME ---"

    # Change into the example directory and run commands
    (
      cd "$dir"
      echo "  Running deploy..."
      if [ -f "../../.env" ]; then
        bun --env-file ../../.env ./alchemy.run.ts
        bun --env-file ../../.env ./alchemy.run.ts --destroy
      # If we're using Cloudflare state store in CI, verify .alchemy/ folder doesn't exist
      if [ "$ALCHEMY_STATE_STORE" = "cloudflare" ] && [ "$CI" = "true" ]; then
        echo "  Verifying no local state files were created..."
        if [ -d ".alchemy" ]; then
          echo "  Error: .alchemy/ directory exists when using Cloudflare state store in CI"
          exit 1
        fi
      fi
      else
        bun ./alchemy.run.ts
        bun ./alchemy.run.ts --destroy
      fi
    ) # Run in a subshell to automatically return to the original directory

    echo "--- Completed: $EXAMPLE_NAME ---"
    echo ""
  fi
done

echo "All examples processed successfully."
exit 0
