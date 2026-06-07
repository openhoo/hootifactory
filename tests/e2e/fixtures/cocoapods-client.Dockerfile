# CocoaPods client (pod) for the CocoaPods registry e2e round-trip.
FROM ruby:3.3-bookworm

# rsync is required by CocoaPods' downloader cache (`pod install` shells out to it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl rsync \
  && rm -rf /var/lib/apt/lists/* \
  && gem install cocoapods --no-document
