# Crash-loop container: the entrypoint exits non-zero immediately on every
# start, so the process never stays up and no port is ever bound. Used to prove
# a fatal crash is surfaced FAST (bounded) instead of polling the full readiness
# budget — and that this matches the native wrangler + @cloudflare/containers
# behaviour.
FROM oven/bun:latest

EXPOSE 8080
CMD ["bun", "-e", "process.exit(1)"]
