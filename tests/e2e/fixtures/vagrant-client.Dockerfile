# vagrant CLI for the Vagrant box registry e2e consume (`vagrant box add` only
# downloads metadata + the box file, so no hypervisor/provider is needed). No
# stock Docker Hub image ships vagrant; install it from the HashiCorp apt repo.
FROM debian:12

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com bookworm main" > /etc/apt/sources.list.d/hashicorp.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends vagrant \
  && rm -rf /var/lib/apt/lists/*
