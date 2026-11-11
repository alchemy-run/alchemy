FROM alpine
RUN --mount=type=cache,target=/root/.cache --mount=type=secret,id=npmrc,target=/root/.npmrc --network=none npm ci
