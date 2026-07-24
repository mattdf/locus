# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS node-runtime

# Pin the heavyweight TeX runtime so ordinary application deployments only
# build the tiny worker layer below. Keeping package installation out of this
# file prevents changing deployment metadata from forcing a full TeX reinstall.
FROM texlive/texlive:latest-medium@sha256:539ca5f5cc69c5012cc5b7d9978a7bc0a0315524ce5325edde595c6765144b71

COPY --chmod=0555 compile.sh /usr/local/bin/locus-metapost
COPY --chmod=0555 latex.sh /usr/local/bin/locus-latex
COPY --chmod=0555 tikz.sh /usr/local/bin/locus-tikz
COPY worker.mjs /opt/locus/worker.mjs
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

USER 65534:65534
WORKDIR /work
EXPOSE 8090
ENTRYPOINT ["node", "/opt/locus/worker.mjs"]
