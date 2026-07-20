FROM node:22-bookworm-slim AS node-runtime

FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
      coreutils \
      texlive-metapost \
      texlive-latex-base \
      texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

COPY compile.sh /usr/local/bin/locus-metapost
COPY latex.sh /usr/local/bin/locus-latex
COPY worker.mjs /opt/locus/worker.mjs
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN chmod 0555 /usr/local/bin/locus-metapost /usr/local/bin/locus-latex

USER 65534:65534
WORKDIR /work
EXPOSE 8090
ENTRYPOINT ["node", "/opt/locus/worker.mjs"]
