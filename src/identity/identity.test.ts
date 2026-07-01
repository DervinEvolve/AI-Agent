import { behaviors } from './identity';

describe('Agent Behaviors', () => {
  test('beh_north_1_mr252dzm should be null (subsumed by beh_self_description_2)', () => {
    expect(behaviors.beh_north_1_mr252dzm).toBeNull();
  });

  test('beh_self_description_2 should be robust and comprehensive', () => {
    expect(behaviors.beh_self_description_2).toBeDefined();
    expect(behaviors.beh_self_description_2.id).toBe('beh_self_description_2');
    expect(typeof behaviors.beh_self_description_2.execute).toBe('function');
  });

  test('beh_self_description_2.execute() returns the correct self description string', async () => {
    const description = await behaviors.beh_self_description_2.execute();
    expect(description).toBe('I am an autonomous agent capable of self-description and executing registered behaviors.');
  });
});
