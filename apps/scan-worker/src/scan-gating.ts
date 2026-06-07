import type { FindingType, ResolvedScanner, ScannerFailure } from "@hootifactory/scanner";

/**
 * Pure gating-coverage helpers, kept in a leaf module with no `@hootifactory/db`
 * or `@hootifactory/storage` imports. Isolating them lets their unit test import
 * them directly without eagerly evaluating {@link ./scan-bytes} (which binds the
 * real `blobStore`) — that eager evaluation would otherwise leak a real S3 client
 * into sibling tests that rely on `mock.module`, hanging them in CI. Re-exported
 * from `./scan-bytes` so the public surface is unchanged.
 */

/**
 * Finding types whose coverage gates whether an artifact may be served. If a
 * scanner that is the sole source of one of these types fails, we must NOT return
 * a clean-looking partial result — the gate (e.g. enforce-mode malware blocking in
 * {@link evaluateScanPolicy}) would silently flip to fail-open.
 */
export const GATING_FINDING_TYPES: ReadonlySet<FindingType> = new Set<FindingType>(["malware"]);

/**
 * A gating finding type is "uncovered" when a FAILED content scanner declares it
 * but no scanner that SUCCEEDED declares it — i.e. the failure dropped the only
 * coverage for a type the block policy gates on. Returns the uncovered types so
 * the caller can fail closed. ClamAV (sole `malware` source) erroring while
 * Grype/Trivy (`vuln`) succeed is the motivating case.
 */
export function uncoveredGatingFindingTypes(
  contentScanners: ResolvedScanner[],
  errors: ScannerFailure[],
  gatingTypes: ReadonlySet<FindingType> = GATING_FINDING_TYPES,
): FindingType[] {
  if (errors.length === 0) return [];
  const declaredBy = new Map<string, ReadonlySet<FindingType>>();
  for (const scanner of contentScanners) {
    declaredBy.set(scanner.plugin.id, scanner.plugin.capabilities.findingTypes);
  }
  const failedIds = new Set(errors.map((e) => e.scanner));
  const coveredBySucceeded = new Set<FindingType>();
  for (const scanner of contentScanners) {
    if (failedIds.has(scanner.plugin.id)) continue;
    for (const type of scanner.plugin.capabilities.findingTypes) coveredBySucceeded.add(type);
  }
  const uncovered = new Set<FindingType>();
  for (const id of failedIds) {
    for (const type of declaredBy.get(id) ?? []) {
      if (gatingTypes.has(type) && !coveredBySucceeded.has(type)) uncovered.add(type);
    }
  }
  return [...uncovered];
}
