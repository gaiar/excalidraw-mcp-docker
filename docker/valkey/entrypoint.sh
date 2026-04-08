#!/bin/sh
set -e

# Generate ACL file with password from environment
if [ -z "$VALKEY_PASSWORD" ]; then
  echo "ERROR: VALKEY_PASSWORD is not set" >&2
  exit 1
fi

# Write ACL file to /tmp (tmpfs, writable)
cat > /tmp/users.acl <<EOF
user default off
user excalidraw on >$VALKEY_PASSWORD ~checkpoint:* ~cp:* +get +set +del +expire +ping +client|setname +client|setinfo +auth resetchannels
EOF

exec valkey-server /etc/valkey/valkey.conf --aclfile /tmp/users.acl
