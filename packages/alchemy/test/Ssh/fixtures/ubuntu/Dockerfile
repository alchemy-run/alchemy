FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo ca-certificates \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash alchemy \
 && echo 'alchemy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/alchemy
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
