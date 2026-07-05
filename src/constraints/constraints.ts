import { constraint as artifact_no_active_content_9 } from './artifact_no_active_content_9';
import { constraint as con_hitl_binding_integrity_24 } from './con_hitl_binding_integrity_24';

export const constraints = [
  artifact_no_active_content_9,
  con_hitl_binding_integrity_24,
];

export function validateConstraints(constraints: any[]): boolean {
  return constraints.every(
    (c) =>
      typeof c.id === 'string' &&
      typeof c.name === 'string' &&
      typeof c.status === 'string' &&
      typeof c.added_epoch === 'number' &&
      typeof c.description === 'string'
  );
}
