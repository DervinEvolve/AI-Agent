import { describe, expect, it } from 'vitest';

import { cap_browser_automation_8 } from '../cap_browser_automation_8';

const extractEnumValues = (enumDescription: string): string[] =>
  [...enumDescription.matchAll(/'([^']+)'/g)].map((match) => match[1]);

describe('cap_browser_automation_8 security contract consistency', () => {
  it('keeps the declared browser actions aligned with the policy-sensitive implementation test plan', () => {
    const actions = extractEnumValues(cap_browser_automation_8.interface.inputs.action);

    expect(new Set(actions)).toEqual(
      new Set([
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
      ])
    );
    expect(actions).toHaveLength(new Set(actions).size);

    const implementationTests = cap_browser_automation_8.implementation.tests.join('\n').toLowerCase();

    for (const action of ['click', 'type', 'extract', 'screenshot']) {
      expect(implementationTests).toContain(action);
    }

    expect(implementationTests).toContain('visible user-page elements');
    expect(implementationTests).toContain('schema-conformant structured data');
    expect(implementationTests).toContain('artifact without leaking host filesystem paths');
    expect(implementationTests).toContain('unified budgettracker');
  });

  it('pairs dangerous navigation deny-tests with network contract blocks and policy_blocked output', () => {
    const implementationTests = cap_browser_automation_8.implementation.tests.join('\n').toLowerCase();
    const networkContract = cap_browser_automation_8.implementation.network_contract.toLowerCase();
    const statusValues = extractEnumValues(cap_browser_automation_8.interface.outputs.status);

    expect(statusValues).toContain('policy_blocked');
    expect(implementationTests).toContain('deny open when url host is not in task egress allowlist');
    expect(networkContract).toContain('deny-by-default egress');
    expect(networkContract).toContain('redirects are checked hop-by-hop');

    for (const blockedTarget of ['private', 'localhost', 'file://', 'data:', 'metadata']) {
      expect(networkContract).toContain(blockedTarget);
    }
  });

  it('marks rendered web content as tainted evidence rather than executable controller instructions', () => {
    expect(cap_browser_automation_8.interface.outputs.tainted).toBe('bool');
    expect(cap_browser_automation_8.interface.outputs.provenance).toBe('object');

    const taintContract = cap_browser_automation_8.implementation.taint_and_provenance.toLowerCase();
    const controllerIntegration = cap_browser_automation_8.implementation.controller_integration.toLowerCase();
    const description = cap_browser_automation_8.description.toLowerCase();

    expect(description).toContain('untrusted web content');
    expect(description).toContain('tainted by default');
    expect(taintContract).toContain('all page content');
    expect(taintContract).toContain('tainted=true');
    expect(taintContract).toContain('web content never is');
    expect(controllerIntegration).toContain('browser observations are evidence, not instructions');
    expect(controllerIntegration).toContain('cannot directly set tool parameters without validation');
  });
});
