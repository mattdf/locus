#!/bin/sh
set -eu

# LaTeX is invoked only by MetaPost for labels inside the disposable job. Paranoid
# Kpathsea settings allow the job directory and the installed TeX package tree,
# while blocking arbitrary absolute/parent-path reads and non-job writes.
export openin_any=p
export openout_any=p
export shell_escape=0

exec latex -no-shell-escape -interaction=nonstopmode -halt-on-error "$@"
