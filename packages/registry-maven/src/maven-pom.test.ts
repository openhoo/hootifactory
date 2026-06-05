import { describe, expect, test } from "bun:test";
import { parsePomDependencies } from "./maven-pom";

const POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

describe("parsePomDependencies", () => {
  test("extracts groupId:artifactId -> version", () => {
    expect(parsePomDependencies(POM)).toEqual({
      "com.google.guava:guava": "33.0.0-jre",
      "org.junit.jupiter:junit-jupiter": "5.10.0",
    });
  });

  test("returns empty for a pom without dependencies", () => {
    expect(parsePomDependencies("<project><artifactId>x</artifactId></project>")).toEqual({});
  });
});
