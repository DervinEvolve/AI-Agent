import { describe, expect, it } from 'vitest';

import {
  cap_browser_automation_8,
  capabilities
} from '../cap_browser_automation_8';

describe('cap_browser_automation_8 capability spec', () => {
  it('registers the browser_control capability with the expected actions and outputs', () => {
    expect(capabilities.capabilities).toContain(cap_browser_automation_8);
    expect(cap_browser_automation_8.id).toBe('cap_browser_automation_8');
    expect(cap_browser_automation_8.status).toBe('active');
    expect(cap_browser_automation_8.interface.tool_name).toBe('browser_control');

    const requiredActions = [
      'open',
      'click',
      'type',
      'select',
      'scroll',
      'wait_for',
      'extract',
      'screenshot',
      'go_back',
      'close'
    ];

    for (const action of requiredActions) {
      expect(cap_browser_automation_8.interface.inputs.action).toContain(`'${action}'`);
    }

    expect(cap_browser_automation_8.interface.inputs.max_observation_bytes).toContain('65536');
    expect(cap_browser_automation_8.interface.inputs.max_observation_bytes).toContain('262144');
    expect(cap_browser_automation_8.interface.outputs.status).toContain('policy_blocked');
    expect(cap_browser_automation_8.interface.outputs.status).toContain('budget_exhausted');
    expect(cap_browser_automation_8.interface.outputs.status).toContain('timeout');
    expect(cap_browser_automation_8.interface.outputs.tainted).toBe('bool');
    expect(cap_browser_automation_8.interface.outputs.provenance).toBe('object');
  });

  it('documents deny-by-default egress, redirect validation, and blocked local schemes', () => {
    const networkContract = cap_browser_automation_8.implementation.network_contract;

    expect(networkContract).toContain('deny-by-default egress');
    expect(networkContract).toContain('scheme, host, and port');
    expect(networkContract).toContain('Redirects are checked hop-by-hop');
    expect(networkContract).toContain('Private networks');
    expect(networkContract).toContain('localhost');
    expect(networkContract).toContain('link-local');
    expect(networkContract).toContain('file://');
    expect(networkContract).toContain('data:');
    expect(networkContract).toContain('metadata services');
  });

  it('captures sandbox, session lifecycle, and budget invariants required by the browser adapter', () => {
    const implementation = cap_browser_automation_8.implementation;

    expect(implementation.modules).toEqual([
      'tools/browser_control_adapter.py',
      'browser/session_manager.py',
      'browser/policy.py',
      'browser/dom_sanitizer.py',
      'browser/artifacts.py'
    ]);

    expect(implementation.execution_contract).toContain('sandbox execution environment');
    expect(implementation.execution_contract).toContain('never exposes host paths');
    expect(implementation.execution_contract).toContain('never shares a persistent browser profile');
    expect(implementation.session_lifecycle).toContain('Profiles are ephemeral');
    expect(implementation.session_lifecycle).toContain('max 3 concurrent browser sessions');
    expect(implementation.session_lifecycle).toContain('max 50 browser actions');
    expect(implementation.session_lifecycle).toContain('max 10 MB total browser artifacts');
    expect(implementation.tests).toContain('browser actions consume unified BudgetTracker step/time/network budget');
    expect(implementation.tests).toContain('cookies, localStorage, cache, downloads, and credentials are cleared on FINISH/FAIL');
  });

  it('treats rendered web content and artifacts as tainted observations, not instructions', () => {
    const implementation = cap_browser_automation_8.implementation;

    expect(cap_browser_automation_8.description).toContain('untrusted web content');
    expect(cap_browser_automation_8.description).toContain('tainted by default');
    expect(implementation.taint_and_provenance).toContain('tainted=true');
    expect(implementation.taint_and_provenance).toContain('source URL');
    expect(implementation.taint_and_provenance).toContain('redirect chain');
    expect(implementation.taint_and_provenance).toContain('selector provenance');
    expect(implementation.controller_integration).toContain('observations are evidence, not instructions');
    expect(implementation.tests).toContain('malicious page text containing tool-like instructions is returned tainted and not executed as controller instructions');
    expect(implementation.tests).toContain('downloaded files are quarantined as tainted artifacts and never executed automatically');
  });

  it('requires DOM sanitization, visible element interaction, artifact isolation, and sensitive-action controls', () => {
    const implementation = cap_browser_automation_8.implementation;

    expect(implementation.observation_limits).toContain('capped by max_observation_bytes');
    expect(implementation.observation_limits).toContain('Full screenshots are stored as artifacts rather than inlined');
    expect(implementation.tests).toContain('click and type operate only on visible user-page elements matching provided selectors');
    expect(implementation.tests).toContain('DOM observations are sanitized: scripts, event handlers, hidden executable payloads, and oversized content are stripped or truncated');
    expect(implementation.tests).toContain('screenshot stores an artifact without leaking host filesystem paths');
    expect(implementation.tests).toContain('browser_control is inaccessible from run_python and dynamically registered custom tools');
    expect(implementation.tests).toContain('form submission with irreversible or sensitive effect requires explicit user confirmation');
    expect(implementation.tests).toContain('credential entry is blocked unless credentials are supplied through an approved secret channel and target origin is user-approved');
  });
});
