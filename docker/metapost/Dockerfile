FROM node:22-bookworm-slim AS node-runtime

FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
      coreutils \
      dvisvgm \
      texlive-metapost \
      texlive-latex-base \
      texlive-fonts-recommended \
      texlive-pictures \
    && rm -rf /var/lib/apt/lists/*

COPY compile.sh /usr/local/bin/locus-metapost
COPY latex.sh /usr/local/bin/locus-latex
COPY tikz.sh /usr/local/bin/locus-tikz
COPY worker.mjs /opt/locus/worker.mjs
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN chmod 0555 /usr/local/bin/locus-metapost /usr/local/bin/locus-latex /usr/local/bin/locus-tikz

USER 65534:65534
WORKDIR /work
EXPOSE 8090
ENTRYPOINT ["node", "/opt/locus/worker.mjs"]
