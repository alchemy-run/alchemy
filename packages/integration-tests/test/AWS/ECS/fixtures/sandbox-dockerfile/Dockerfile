# An image with a process and a user of its own. Nothing in it knows about
# sandboxes.
FROM python:3.12-slim
COPY index.txt /srv/index.txt
USER nobody
ENTRYPOINT ["python3", "-m", "http.server"]
CMD ["8000", "--directory", "/srv"]
