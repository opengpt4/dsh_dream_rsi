/**
 * Small-sample aggregation for per-family reporting.
 *
 * Uses a Student-t critical value rather than 1.96, because evaluation samples
 * are small: the interval at five samples is 1.4x the normal-approximation
 * width and at three samples 2.2x, which is the difference between "no
 * regression" and "cannot tell yet". At 32 samples the table runs out and 1.96
 * is within 4%, so the fallback costs nothing.
 */

export interface Aggregate {
  readonly sampleCount: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** 95% confidence interval for the mean. `null` when one sample cannot support one. */
  readonly lower: number | null;
  readonly upper: number | null;
}

/** Two-tailed 95% critical values, indexed by degrees of freedom 1..30. */
const T95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
];

const Z95 = 1.96;

export function tCritical95(degreesOfFreedom: number): number {
  if (!Number.isInteger(degreesOfFreedom) || degreesOfFreedom <= 0) {
    throw new Error('degreesOfFreedom must be a positive integer');
  }
  return degreesOfFreedom <= T95.length ? T95[degreesOfFreedom - 1]! : Z95;
}

export const EMPTY_AGGREGATE: Aggregate = {
  sampleCount: 0,
  mean: 0,
  min: 0,
  max: 0,
  lower: null,
  upper: null
};

export function aggregate(values: readonly number[]): Aggregate {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`cannot aggregate a non-finite value: ${value}`);
  }
  if (values.length === 0) return EMPTY_AGGREGATE;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) {
    // One observation has a mean but no interval: reporting 0 width would claim
    // a precision the sample does not support.
    return { sampleCount: 1, mean, min: values[0]!, max: values[0]!, lower: null, upper: null };
  }

  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  const margin = tCritical95(values.length - 1) * standardError;

  return {
    sampleCount: values.length,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    lower: mean - margin,
    upper: mean + margin
  };
}

/** Mean of a boolean series, which is the rate. */
export function rate(flags: readonly boolean[]): Aggregate {
  return aggregate(flags.map((flag) => (flag ? 1 : 0)));
}
