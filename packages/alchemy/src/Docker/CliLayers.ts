/**
 * Image layers that install common CLIs (deduplicated by id, so several
 * bindings can ask for the same one).
 */
import type { ImageLayer } from "./ImageLayer.ts";

/** git and CA certificates (apt, apk or dnf). */
export const gitCliLayer: ImageLayer = {
  id: "git-cli",
  stage: "setup",
  instructions:
    "RUN if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*; elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates git; elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates git && dnf clean all; fi",
};

/** The GitHub CLI. */
export const ghCliLayer: ImageLayer = {
  id: "gh-cli",
  stage: "setup",
  instructions: [
    "RUN if command -v apt-get >/dev/null 2>&1; then \\",
    "    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && \\",
    "    mkdir -p -m 755 /etc/apt/keyrings && \\",
    "    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\",
    "    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\",
    '    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\',
    "    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*; \\",
    "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache github-cli; \\",
    "  elif command -v dnf >/dev/null 2>&1; then \\",
    "    curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo && \\",
    "    dnf install -y gh && dnf clean all; fi",
  ].join("\n"),
};
