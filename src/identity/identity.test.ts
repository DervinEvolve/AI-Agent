import { describe, it, expect } from 'vitest';
import describeSelf, { DOMAIN, DESCRIPTION } from './identity';
import * as identityModule from './identity';

describe('identity self-description', () => {
  it('formalizes the domain as educational mathematics assistance', () => {
    expect(DOMAIN).toBe('educational mathematics assistance');
  });

  it('description always includes the words purpose and domain', () => {
    expect(DESCRIPTION.toLowerCase()).toContain('purpose');
    expect(DESCRIPTION.toLowerCase()).toContain('domain');
  });

  it('embeds the canonical domain phrase in the description', () => {
    expect(DESCRIPTION).toContain(DOMAIN);
  });

  it('returns a purpose/domain/description object consistent with the constants', () => {
    const result = describeSelf();

    expect(result).toEqual({
      purpose:
        'To help users understand and correctly compute the addition of two integers.',
      domain: DOMAIN,
      description: DESCRIPTION,
    });

    expect(result.description).toContain(result.domain);
  });

  it('is the default export', () => {
    expect(identityModule.default).toBe(describeSelf);
  });

  it('exposes exactly one behavior for purpose/domain queries', () => {
    const selfDescriptionBehaviors = Object.entries(identityModule)
      .filter(
        ([name, value]) =>
          typeof value === 'function' &&
          /self|describe|purpose|domain/i.test(name),
      );

    expect(selfDescriptionBehaviors).toHaveLength(1);
    expect(selfDescriptionBehaviors[0][0]).toBe('describeSelf');
  });
});
