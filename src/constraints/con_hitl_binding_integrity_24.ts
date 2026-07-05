export const conHitlBindingIntegrity24 = {
  id: 'con_hitl_binding_integrity_24',
  name: 'Cryptographic HITL binding integrity and non-repudiation',
  status: 'active',
  added_epoch: 25,
  description: 'Every HITL approval for a consequential, irreversible, state-changing, costly, authenticated, or unknown-consequence action must be cryptographically bound to the exact action payload, target adapter, target endpoint, vault grant, and timestamp. At dispatch time, the executing adapter must verify the approval_token against the canonicalized action tuple; any mismatch in action_payload_hash, target_adapter, target_endpoint, vault_grant_id, or nonce must result in invalid_signature and policy_blocked, regardless of any claims, dialogue state, memory, traces, or controller context. Approval tokens are single-use and must be cryptographically invalidated after one successful verification. Prompt-injection attacks that modify the action payload after approval produce a different binding_hash and are mathematically prevented from executing. No context, memory, trace, claim, dialogue state, or sub-agent output can substitute for a valid, unexpired, action-bound approval_token. Plaintext approvals without cryptographic binding are rejected. This constraint applies to cap_hitl_communication_16, cap_hitl_orchestration_24, and any future approval mechanism.',
  implementation: {
    tests: [
      'a dispatch with an approval_token bound to action A but attempting to execute action B returns invalid_signature',
      'a dispatch with an approval_token bound to a different vault_grant_id returns invalid_signature',
      'a dispatch with an approval_token bound to a different target_endpoint returns invalid_signature',
      'a replayed approval_token (already consumed) returns invalid_signature',
      'a plaintext \'approved\' message without cryptographic binding token is rejected by the orchestrator',
      'context, memory, or claim content cannot substitute for a missing or mismatched approval_token',
      'sub-agent output claiming approval is rejected; only the cryptographically verified token from the orchestrator is valid',
      'token verification runs at dispatch time in the adapter\'s verification hook, not in the controller prompt'
    ]
  }
};
