# A minimal shell-exec MicroVM: the official Lambda MicroVM base image plus bun,
# running a tiny Bun.serve HTTP server that spawns commands and streams their
# combined stdout/stderr back to the caller as the process produces it.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y unzip tar \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && dnf clean all

WORKDIR /app
COPY server.js .

EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["bun", "/app/server.js"]
