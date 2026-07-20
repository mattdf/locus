#!/bin/sh
set -eu

umask 022
cd "${LOCUS_WORKDIR:-/work}"
test -f figure.mp

# The host applies an additional deadline. This in-container limit remains in
# force if the Docker client disconnects midway through a compilation.
timeout --signal=KILL 6s \
  mpost -tex=/usr/local/bin/locus-latex -interaction=nonstopmode -halt-on-error figure.mp \
  > compiler.log 2>&1

test -s figure-1.svg
