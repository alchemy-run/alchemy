FROM busybox:1.36

ARG GREETING
# Serve what the build saw: the build arg verbatim, and the secret's length
# rather than its value, so the page proves the mount without leaking it.
RUN --mount=type=secret,id=token,required=true \
  mkdir -p /www \
  && echo "$GREETING $(wc -c < /run/secrets/token)" > /www/index.html

EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
