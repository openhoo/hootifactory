# git + git-lfs client for the Git LFS registry e2e round-trip.
FROM debian:12

RUN apt-get update \
  && apt-get install -y --no-install-recommends git git-lfs ca-certificates \
  && rm -rf /var/lib/apt/lists/*
