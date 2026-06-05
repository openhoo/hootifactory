/**
 * Best-effort POM dependency reader. Maven clients transmit only files, so the
 * dependency graph is recovered from the `.pom` XML. Regex-based, mirroring the
 * NuGet `.nuspec` reader — robust enough to feed the OSV/dependency graph.
 */

const MAX_POM_BYTES = 4 * 1024 * 1024;
const MAX_DEPENDENCIES = 1000;

function tagValue(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`))?.[1]?.trim();
}

/** Map of `groupId:artifactId` -> version constraint (empty string when inherited). */
export function parsePomDependencies(xml: string): Record<string, string> {
  if (xml.length > MAX_POM_BYTES) return {};
  const out: Record<string, string> = {};
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null = depRe.exec(xml);
  let count = 0;
  while (match && count < MAX_DEPENDENCIES) {
    count += 1;
    const block = match[1] ?? "";
    const groupId = tagValue(block, "groupId");
    const artifactId = tagValue(block, "artifactId");
    if (groupId && artifactId) {
      out[`${groupId}:${artifactId}`] = tagValue(block, "version") ?? "";
    }
    match = depRe.exec(xml);
  }
  return out;
}
