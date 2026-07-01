import { safeCompute, ComputeResult } from '../constraints/constraints';

const ALLOWED = ['-'];

export function computeSubtraction(operator: unknown, operands: unknown[]): ComputeResult {
  return safeCompute(operator, operands, ALLOWED, (ops) =>
    ops.slice(1).reduce((acc, n) => acc - n, ops[0]),
  );
}

export const capability = {
  name: 'basic_subtraction',
  version: '5',
  allowed_operators: ALLOWED,
  compute: computeSubtraction,
};

export default capability;
