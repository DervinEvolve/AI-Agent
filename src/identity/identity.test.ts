import { identity } from './identity';

describe('Identity configuration', () => {
  it('should have the correct name', () => {
    expect(identity.name).toBe('AI-Agent');
  });

  it('should have the deprecated beh_north_1_mr25jsz0 behavior set to null', () => {
    expect(identity.behaviors.behaviors.beh_north_1_mr25jsz0).toBeNull();
  });

  it('should have the active beh_self_description_2 behavior properly configured', () => {
    const selfDesc = identity.behaviors.behaviors.beh_self_description_2;
    expect(selfDesc).toBeDefined();
    expect(selfDesc).not.toBeNull();
    expect(selfDesc?.id).toBe('beh_self_description_2');
    expect(selfDesc?.name).toBe('Robust Self Description');
    expect(selfDesc?.description).toContain('robust self-description');
  });
});
