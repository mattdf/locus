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
RUN chmod 0555 /usr/local/bin/locus-metapost /usr/local/bin/locus-latex

USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/locus-metapost"]
