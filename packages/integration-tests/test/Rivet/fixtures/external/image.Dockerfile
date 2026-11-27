# A prebuilt RivetKit image, as an app would ship one: its runtime and
# RivetKit installed when the image is built, never when a node starts.
FROM oven/bun:1
WORKDIR /app
RUN bun add rivetkit@3.0.0
COPY async-actors.ts .
# What each increment counts for, so a new image is told apart from the old.
ARG STEP=1
ENV STEP=${STEP}
CMD ["bun", "--no-install", "async-actors.ts"]
