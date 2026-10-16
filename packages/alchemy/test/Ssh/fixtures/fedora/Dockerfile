FROM fedora:42
RUN dnf -y -q install openssh-server sudo \
 && ssh-keygen -A \
 && useradd -m alchemy \
 && echo 'alchemy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/alchemy
COPY start.sh /start.sh
CMD ["sh", "/start.sh"]
