#!/usr/bin/env bash
# Usage: scripts/mm-logs.sh [-f] [-n LINES] [-s SINCE] [-e]
#   -f        follow live
#   -n LINES  number of lines (default 200)
#   -s SINCE  e.g. "1 hour ago", "today"
#   -e        errors and warnings only
# Runs journalctl directly when the magicmirror service is on this machine,
# otherwise SSHes to the Pi. Override the target with PI_HOST=user@host

PI_HOST_OVERRIDE="${PI_HOST:-}"
PI_HOST="${PI_HOST:-admin@192.168.40.182}"
lines=200
args=()

while getopts "fn:s:e" opt; do
	case $opt in
		f) args+=(-f) ;;
		n) lines=$OPTARG ;;
		s) args+=(--since "$OPTARG") ;;
		e) args+=(-p warning) ;;
		*) exit 1 ;;
	esac
done

if [[ " ${args[*]} " != *" --since "* ]]; then
	args+=(-n "$lines")
fi

if [[ -z "${PI_HOST_OVERRIDE:-}" ]] && systemctl cat magicmirror.service >/dev/null 2>&1; then
	exec journalctl -u magicmirror --no-pager -o short-iso "${args[@]}"
fi

ssh -t "$PI_HOST" "journalctl -u magicmirror --no-pager -o short-iso ${args[*]@Q}"
