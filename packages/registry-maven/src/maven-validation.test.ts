import { describe, expect, test } from "bun:test";
import {
  contentTypeForPath,
  isPrimaryPom,
  isSafeMavenPath,
  mavenPackageForPath,
  parseMavenCoordinates,
} from "./maven-validation";

describe("maven path validation", () => {
  test("accepts coordinate paths and rejects traversal", () => {
    expect(isSafeMavenPath("com/example/app/1.0.0/app-1.0.0.jar")).toBe(true);
    expect(isSafeMavenPath("com/example/app/maven-metadata.xml")).toBe(true);
    expect(isSafeMavenPath("../secret")).toBe(false);
    expect(isSafeMavenPath("a//b")).toBe(false);
    expect(isSafeMavenPath("a/b/")).toBe(false);
    expect(isSafeMavenPath("/abs")).toBe(false);
  });

  test("maps extensions to content types", () => {
    expect(contentTypeForPath("a/b-1.0.jar")).toBe("application/java-archive");
    expect(contentTypeForPath("a/b-1.0.pom")).toBe("application/xml");
    expect(contentTypeForPath("a/b-1.0.jar.sha1")).toBe("text/plain");
    expect(contentTypeForPath("a/b-1.0.unknown")).toBe("application/octet-stream");
  });
});

describe("maven coordinates", () => {
  test("parses group/artifact/version/file", () => {
    expect(parseMavenCoordinates("com/example/app/1.0.0/app-1.0.0.jar")).toEqual({
      groupId: "com.example",
      artifactId: "app",
      version: "1.0.0",
      file: "app-1.0.0.jar",
    });
    expect(parseMavenCoordinates("too/short")).toBeNull();
  });

  test("identifies the primary pom", () => {
    const coords = parseMavenCoordinates("com/example/app/1.0.0/app-1.0.0.pom");
    expect(coords && isPrimaryPom(coords)).toBe(true);
    const sources = parseMavenCoordinates("com/example/app/1.0.0/app-1.0.0-sources.jar");
    expect(sources && isPrimaryPom(sources)).toBe(false);
  });

  test("derives the package only for real artifact files", () => {
    expect(mavenPackageForPath("com/example/app/1.0.0/app-1.0.0.jar")).toBe("com.example:app");
    // maven-metadata.xml lives one level up and must not be mis-scoped to a package
    expect(mavenPackageForPath("com/example/app/maven-metadata.xml")).toBeNull();
  });
});
