#!/bin/bash
# Reads raw stdin bytes and prints hex representation, one read per line.
# Accepts a mode argument to enable specific terminal modes before reading.
#
# Usage: input-probe.sh [mode]
#   mode: normal | decckm | bracketed | mouse | focus | all
#
# Output format: PROBE:<hex>
# The PROBE: prefix lets the test harness find output reliably in screen content.

MODE="${1:-normal}"

enable_modes() {
  case "$MODE" in
    decckm)    printf '\e[?1h' ;;
    bracketed) printf '\e[?2004h' ;;
    mouse)     printf '\e[?1000h\e[?1006h' ;;
    focus)     printf '\e[?1004h' ;;
    all)       printf '\e[?1h\e[?2004h\e[?1000h\e[?1006h\e[?1004h' ;;
    normal)    ;;
  esac
}

disable_modes() {
  case "$MODE" in
    decckm)    printf '\e[?1l' ;;
    bracketed) printf '\e[?2004l' ;;
    mouse)     printf '\e[?1000l\e[?1006l' ;;
    focus)     printf '\e[?1004l' ;;
    all)       printf '\e[?1l\e[?2004l\e[?1000l\e[?1006l\e[?1004l' ;;
    normal)    ;;
  esac
}

cleanup() {
  disable_modes
  stty "$ORIG_STTY" 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

ORIG_STTY=$(stty -g)
stty raw -echo

enable_modes

printf 'READY:%s\r\n' "$MODE"

READS=0
MAX_READS=20
while [ "$READS" -lt "$MAX_READS" ]; do
  BYTE=$(dd bs=64 count=1 2>/dev/null | od -A n -t x1 | tr -d ' \n')
  if [ -n "$BYTE" ]; then
    printf 'PROBE:%s\r\n' "$BYTE"
    READS=$((READS + 1))
  fi
done

printf 'DONE\r\n'
