/**
 * EvidenceValidator handlers for citation shapes 9 and 10.
 * Neither settles an unknown outcome, closes a recovery slot, or
 * satisfies a TaskContract by itself.
 */

import type { InputManifest } from "./artifact_store.js";
import {
  validateShape9,
  validateShape10,
  type ExportReceipt,
  type Shape9Citation,
  type Shape10Citation,
} from "./artifact_io.js";

export const SHAPE_9 = 9;
export const SHAPE_10 = 10;

export interface EvidenceCheck {
  shape: number;
  valid: boolean;
  reason: string;
  settlesOutcome: false;
  closesRecovery: false;
  satisfiesTaskContract: false;
}

export function checkCitation(opts: {
  shape: number;
  citation: unknown;
  currentRunExports: readonly ExportReceipt[];
  inputManifest: InputManifest | null | undefined;
}): EvidenceCheck {
  const base = {
    settlesOutcome: false as const,
    closesRecovery: false as const,
    satisfiesTaskContract: false as const,
  };
  if (opts.shape === SHAPE_9) {
    const r = validateShape9(opts.citation as Shape9Citation, opts.currentRunExports);
    return { shape: 9, valid: r.valid, reason: r.reason, ...base };
  }
  if (opts.shape === SHAPE_10) {
    const r = validateShape10(opts.citation as Shape10Citation, opts.inputManifest);
    return { shape: 10, valid: r.valid, reason: r.reason, ...base };
  }
  return {
    shape: opts.shape,
    valid: false,
    reason: "unsupported citation shape for artifact io",
    ...base,
  };
}

/** Register both handlers if EvidenceValidator exposes registerHandler. */
export function registerArtifactEvidenceHandlers(validator: {
  registerHandler?: (shape: number, fn: (citation: unknown, ctx: unknown) => { valid: boolean; reason: string }) => void;
}): void {
  if (typeof validator.registerHandler !== "function") return;
  validator.registerHandler(SHAPE_9, (citation, ctx) => {
    const c = ctx as { currentRunExports?: ExportReceipt[] };
    return validateShape9(citation as Shape9Citation, c.currentRunExports ?? []);
  });
  validator.registerHandler(SHAPE_10, (citation, ctx) => {
    const c = ctx as { inputManifest?: InputManifest | null };
    return validateShape10(citation as Shape10Citation, c.inputManifest);
  });
}
