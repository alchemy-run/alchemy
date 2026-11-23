# The bank server: built with Lean, run on a small image.
#
#   docker build -t lean-bank . && docker run -p 8787:8787 -v bank:/data lean-bank
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  | sh -s -- -y --default-toolchain none
WORKDIR /src
COPY lean-toolchain lakefile.toml lake-manifest.json ./
RUN /root/.elan/bin/lake --version
COPY Alchemy.lean ./
COPY Alchemy ./Alchemy
COPY examples ./examples
RUN /root/.elan/bin/lake build bank

FROM debian:bookworm-slim
# curl is how the server calls the outside systems at FRAUD_URL and PAYMENTS_URL.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/.lake/build/bin/bank /usr/local/bin/bank
VOLUME /data
EXPOSE 8787
CMD ["bank", "/data/bank.journal", "8787", "public"]
