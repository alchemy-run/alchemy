# The bank server: compiled by Bend to JavaScript, run by bun.
#
#   docker build -t bend-bank . && docker run -p 8788:8788 -v bank:/data bend-bank
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bend-lang.com/install.sh | sh
WORKDIR /src
COPY Domain.bend Model.bend ./
COPY examples ./examples
RUN cd examples/bank && BEND_NO_TELEMETRY=1 /root/.bend/bin/bend Server.bend -o /bank.js \
  && mv /bank.js /bank.cjs

FROM oven/bun:1-slim
# curl is how the server calls the outside systems at FRAUD_URL and PAYMENTS_URL.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /bank.cjs /app/bank.cjs
ENV BANK_HOST=0.0.0.0
WORKDIR /data
VOLUME /data
EXPOSE 8788
CMD ["bun", "/app/bank.cjs"]
