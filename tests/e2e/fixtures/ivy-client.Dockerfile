# sbt client for the Ivy registry e2e, pre-warmed so test-time resolution is fast
# and hermetic for scala: bake scala-library + sbt's own deps into a world-writable
# ivy home / boot dir, so the e2e `sbt update` resolves scala offline from the cache
# and only the test's own artifact hits the network (avoids a slow, flaky Maven
# Central pull under parallel CI load).
FROM sbtscala/scala-sbt:eclipse-temurin-jammy-17.0.10_7_1.9.9_2.13.13

RUN mkdir -p /warmup/project /opt/ivy-cache /opt/sbt-boot \
  && printf 'sbt.version=1.9.9\n' > /warmup/project/build.properties \
  && printf 'ThisBuild / useCoursier := false\nThisBuild / scalaVersion := "2.13.13"\n' > /warmup/build.sbt \
  && cd /warmup \
  && sbt -Dsbt.ivy.home=/opt/ivy-cache -Dsbt.boot.directory=/opt/sbt-boot --batch update \
  && chmod -R 0777 /opt/ivy-cache /opt/sbt-boot \
  && rm -rf /warmup
