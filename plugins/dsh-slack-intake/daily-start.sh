#!/bin/bash
# Keep this launcher on a filesystem available before the store mount.
set -eu

guard=
unit=
profile=
if [[ "${1:-}" == '--check-placement' ]]; then
  if (( $# < 9 )); then exit 64; fi
  guard=$2
  unit=$3
  profile=$4
  shift 4
fi
if (( $# < 5 )); then
  echo 'usage: daily-start.sh [--check-placement GUARD UNIT PROFILE] WAIT_SECONDS MOUNT STORE NODE CLI [CLI_ARGS...]' >&2
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
while ! { mountpoint -q -- "$mount_root" && [[ -d "$store" && -x "$node" && -r "$cli" ]] && { [[ -z "$guard" ]] || [[ -r "$guard" ]]; }; }; do
  if (( SECONDS >= wait_seconds )); then
    echo 'DAILY_START_READINESS_TIMEOUT' >&2
    exit 75
  fi
  if (( SECONDS == 0 )); then
    echo 'DAILY_START_WAITING_FOR_STORAGE' >&2
  fi
  sleep 1
done
if [[ -n "$guard" ]]; then
  /usr/bin/python3 -B "$guard" --unit "$unit" --profile "$profile" || exit 78
fi
cd -- "$store"
# Only pre-application readiness may request a systemd retry with exit 75.
result=0
"$node" "$cli" "$@" || result=$?
if (( result == 75 )); then exit 1; fi
exit "$result"
