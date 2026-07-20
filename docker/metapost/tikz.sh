#!/bin/sh
set -eu

umask 022
cd "${LOCUS_WORKDIR:-/work}"
test -f figure.tex

# TeX runs without shell escape, network access, or a writable filesystem beyond
# this throwaway job directory. The host also enforces a separate deadline.
export HOME=/tmp
export openin_any=p
export openout_any=p
timeout --signal=KILL 6s \
  latex -no-shell-escape -interaction=nonstopmode -halt-on-error figure.tex \
  > compiler.log 2>&1

timeout --signal=KILL 2s \
  dvisvgm --no-fonts --bbox=min --output=figure.svg figure.dvi \
  >> compiler.log 2>&1

test -s figure.svg
