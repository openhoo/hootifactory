# Minimal HTTP client (curl) for the generic/raw registry e2e round-trip.
FROM debian:12

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
