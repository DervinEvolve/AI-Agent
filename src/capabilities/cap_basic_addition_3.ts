import { safeCompute, ComputeResult } from '../constraints/constraints';

const ALLOWED = ['+'];

export function computeAddition(operator: unknown, operands: unknown[]): ComputeResult {
  return safeCompute(operator, operands, ALLOWED, (ops) =>
    ops.reduce((acc, n) => acc + n, 0),
  );
}

export const capability = {
  name: 'basic_addition',
  version: '3',
  allowed_operators: ALLOWED,
  compute: computeAddition,
};

export default capability;
