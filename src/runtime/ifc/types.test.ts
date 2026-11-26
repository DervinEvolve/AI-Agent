import { describe, it, expect } from 'vitest';
import { IFC_CAPS, IFC_REASON_CODES } from './types';

describe('IFC runtime contract', () => {
  it('exports the capability ids used by the approval gate and IFC', () => {
    expect(IFC_CAPS.informationFlowControl).toBe('cap_information_flow_control_75');
    expect(IFC_CAPS.approvalGate).toBe('cap_approval_gate_46');
  });

  it('exports the reason codes the taint checker and tests consume', () => {
    expect(IFC_REASON_CODES.taintDenied).toBe('taint_denied');
    expect(IFC_REASON_CODES.taintIndexSaturated).toBe('taint_index_saturated');
    expect(IFC_REASON_CODES.taintApprovalRequired).toBe('taint_approval_required');
    expect(IFC_REASON_CODES.taintApproved).toBe('taint_approved');
    expect(IFC_REASON_CODES.taintTrustedSpan).toBe('taint_trusted_span');
    expect(IFC_REASON_CODES.taintNoMatch).toBe('taint_no_match');
    expect(IFC_REASON_CODES.taintDisabled).toBe('taint_disabled');
    expect(IFC_REASON_CODES.taintConfigRejected).toBe('taint_config_rejected');
  });
});
