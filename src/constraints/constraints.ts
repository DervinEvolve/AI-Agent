import * as artifactNoActiveContent9Module from "./artifact_no_active_content_9";
import { BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT } from "./biometric_sensitive_perception_11";

export interface ConstraintSpec {
  id: string;
  name: string;
  status: string;
  added_epoch?: number;
  description: string;
  implementation?: unknown;
  [key: string]: unknown;
}

const ARTIFACT_NO_ACTIVE_CONTENT_9_FALLBACK: ConstraintSpec = {
  id: "con_artifact_no_active_content_9",
  name: "No active content in artifacts",
  status: "active",
  added_epoch: 9,
  description:
    "Artifacts produced by the agent must not contain active executable content such as scripts, event handlers, javascript: URLs, or equivalent active payloads."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConstraintSpec(value: unknown): value is ConstraintSpec {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.description === "string"
  );
}

function collectConstraintSpecs(moduleExports: Record<string, unknown>): ConstraintSpec[] {
  const collected: ConstraintSpec[] = [];

  for (const value of Object.values(moduleExports)) {
    if (isConstraintSpec(value)) {
      collected.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      collected.push(...value.filter(isConstraintSpec));
      continue;
    }

    if (isRecord(value) && Array.isArray(value.constraints)) {
      collected.push(...value.constraints.filter(isConstraintSpec));
    }
  }

  return collected;
}

function uniqueById(specs: readonly ConstraintSpec[]): ConstraintSpec[] {
  const seen = new Set<string>();
  const unique: ConstraintSpec[] = [];

  for (const spec of specs) {
    if (seen.has(spec.id)) {
      continue;
    }
    seen.add(spec.id);
    unique.push(spec);
  }

  return unique;
}

const artifactNoActiveContent9Constraints = collectConstraintSpecs(artifactNoActiveContent9Module as Record<string, unknown>);
const hasArtifactNoActiveContent9 = artifactNoActiveContent9Constraints.some((constraint) =>
  constraint.id.includes("artifact_no_active_content_9")
);

export const constraints: readonly ConstraintSpec[] = uniqueById([
  ...(hasArtifactNoActiveContent9 ? artifactNoActiveContent9Constraints : [ARTIFACT_NO_ACTIVE_CONTENT_9_FALLBACK]),
  BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT
]);

export const CONSTRAINTS = constraints;
export const allConstraints = constraints;
export const constraintRegistry = { constraints } as const;

export function getConstraintById(id: string): ConstraintSpec | undefined {
  return constraints.find((constraint) => constraint.id === id);
}

export default constraints;
