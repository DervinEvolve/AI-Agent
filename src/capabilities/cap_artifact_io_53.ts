/**
 * cap_artifact_io_53 — principal-bound artifact input/output.
 * Opt-in. Absent configuration preserves schemas, traces, and adapter-call counts.
 */

import {
  ARTIFACT_LIMITS,
  ArtifactStore,
  EXPORT_ARTIFACT_TOOL,
  exportArtifactToolSchema,
  filterExportFromChildTools,
  type InputManifest,
} from "../runtime/artifact_io.js";
import { registerArtifactEvidenceHandlers } from "../runtime/artifact_evidence.js";

export const CAP_ARTIFACT_IO_53 = Object.freeze({
  id: "cap_artifact_io_53",
  status: "active",
  added_epoch: 53,
  limits: ARTIFACT_LIMITS,
  exportTool: EXPORT_ARTIFACT_TOOL,
});

export interface ArtifactIoConfig {
  enabled: boolean;
  principal: string;
  store?: ArtifactStore;
  authorizerPresent?: boolean;
}

export function artifactIoEnabled(config: ArtifactIoConfig | null | undefined): boolean {
  return config?.enabled === true;
}

/** Absent config: do not alter tool list. */
export function toolsForParent<T extends { name: string }>(
  base: T[],
  config: ArtifactIoConfig | null | undefined,
): T[] {
  if (!artifactIoEnabled(config)) return base.slice();
  const schema = exportArtifactToolSchema() as unknown as T;
  if (base.some((t) => t.name === EXPORT_ARTIFACT_TOOL)) return base.slice();
  return [...base, schema];
}

export function toolsForChild<T extends { name: string }>(base: T[]): T[] {
  return filterExportFromChildTools(base);
}

export function bindRunManifest(
  config: ArtifactIoConfig | null | undefined,
  manifest: InputManifest | null,
): InputManifest | null {
  if (!artifactIoEnabled(config)) return null;
  return manifest;
}

export function tryRegisterEvidence(validator: Parameters<typeof registerArtifactEvidenceHandlers>[0]): void {
  registerArtifactEvidenceHandlers(validator);
}

export { ArtifactStore, ARTIFACT_LIMITS, EXPORT_ARTIFACT_TOOL };
