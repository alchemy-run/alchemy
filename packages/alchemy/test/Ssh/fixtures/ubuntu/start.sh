set -e
install -d -m 700 -o alchemy -g alchemy /home/alchemy/.ssh
printf '%s\n' "$AUTHORIZED_KEY" > /home/alchemy/.ssh/authorized_keys
chown alchemy:alchemy /home/alchemy/.ssh/authorized_keys
chmod 600 /home/alchemy/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
