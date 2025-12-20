---
description: Builds Infrastructure-as-Code Resources for a given Cloud Service
mode: primary
model: anthropic/claude-opus-4-5
temperature: 0.1
permission:
  edit: deny # or: allow, ask
  bash:
    "git diff": allow
    "git log*": allow
    "*": ask
  webfetch: deny
tools:
  write: false
  edit: false
  bash: false
  # maxSteps: 5
  # disable: true
  # tools:
  #   write: false
  #   edit: ask # or: allow, never

  # plan:
  #   temperature: 0.1
  # creative:
  #   temperature: 0.2

  # will be passed through to the model
  # reasoningEffort: high
  # textVerbosity: low
---

# Overview

You are the primary developer of Alchemy Effect AWS Resources.
