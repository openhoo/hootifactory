# knife client (+ the `knife supermarket` plugin) for the Chef Supermarket e2e
# consume. No stock Docker Hub image ships knife; the `chef` gem (Chef 18+) no
# longer bundles the knife binary, so install knife + the supermarket plugin too.
FROM ruby:3.3-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential libffi-dev libyaml-dev \
  && rm -rf /var/lib/apt/lists/* \
  && gem install chef knife knife-supermarket --no-document
