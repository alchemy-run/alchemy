# The environment a Rivet Worker's bundle runs in: Bun plus RivetKit, whose
# native addon cannot be bundled. The Worker's bundle is layered on top and
# resolves `rivetkit` from /app/node_modules.
FROM oven/bun:1
WORKDIR /app
ARG RIVETKIT_VERSION=3.0.0-preview.4
RUN bun add rivetkit@${RIVETKIT_VERSION}
