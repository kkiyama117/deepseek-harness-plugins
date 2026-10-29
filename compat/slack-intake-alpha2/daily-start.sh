#!/bin/bash
# Keep this launcher on a filesystem available before the store mount.
set -eu

if (( $# < 5 )); then
  echo 'usage: daily-start.sh WAIT_SECONDS MOUNT STORE NODE CLI [CLI_ARGS...]' >&2
  exit 64
fi
wait_seconds=$1
mount_root=$2
store=$3
node=$4
cli=$5
shift 5
if [[ ! "$wait_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'WAIT_SECONDS must be a positive integer' >&2
  exit 64
fi

SECONDS=0
while ! { mountpoint -q -- "$mount_root" && [[ -d "$store" && -x "$node" && -r "$cli" ]]; }; do
  if (( SECONDS >= wait_seconds )); then
    echo 'DAILY_START_READINESS_TIMEOUT' >&2
    exit 75
  fi
  if (( SECONDS == 0 )); then
    echo 'DAILY_START_WAITING_FOR_STORAGE' >&2
  fi
  sleep 1
done
cd -- "$store"
exec "$node" "$cli" "$@"
