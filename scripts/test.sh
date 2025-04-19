#!/usr/bin/env bash

# Find all test files in the alchemy/test directory
TEST_FILES=$(find ./alchemy/test -name "*.test.ts")

# Create a temporary directory to store output
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Array to store all background process IDs
PIDS=()

# Print header
echo "Running tests in parallel..."
echo "============================"

# Function to run a test and print its output once it completes
run_test() {
  local test_file="$1"
  local output_file="$2"
  
  # Run the test and capture output
  bun test "$test_file" > "$output_file" 2>&1
  local exit_code=$?
  
  # Create a lock file to synchronize output
  flock "/tmp/test-output.lock" bash -c "
    echo \"=============================\"
    echo \"Results for: $test_file (Exit code: $exit_code)\"
    echo \"=============================\"
    cat \"$output_file\"
    echo \"\"
  "
  
  return $exit_code
}

# Run tests in parallel
for test_file in $TEST_FILES; do
  output_file="$TEMP_DIR/$(basename "$test_file").out"
  (run_test "$test_file" "$output_file"; exit $?) &
  PIDS+=($!)
done

# Wait for all processes to complete
echo "Waiting for all tests to complete..."
FAILED=0
for pid in "${PIDS[@]}"; do
  wait $pid
  exit_code=$?
  if [ $exit_code -ne 0 ]; then
    FAILED=1
  fi
done

# Report status
if [ $FAILED -eq 0 ]; then
  echo "============================"
  echo "All tests completed successfully!"
  exit 0
else
  echo "============================"
  echo "Some tests failed. Check the output above for details."
  exit 1
fi
