# The Python consumers (service.py, scientist.py): every dependency fixed at build time,
# so a test run downloads nothing. Regenerate requirements.lock from requirements.in with:
#   uv pip compile requirements.in --generate-hashes --python-version 3.12 \
#     --python-platform x86_64-unknown-linux-gnu -o requirements.lock
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58
WORKDIR /consumers
COPY requirements.lock .
RUN uv pip install --system --require-hashes --no-cache -r requirements.lock
# DuckDB's extensions, which it would otherwise download on first use.
RUN python -c "import duckdb; c = duckdb.connect(); [c.install_extension(e) for e in ('iceberg', 'httpfs', 'avro')]"
COPY lake.py service.py scientist.py ./
