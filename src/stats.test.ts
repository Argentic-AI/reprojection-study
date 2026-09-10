import { bootstrap, bootstrap_diff, pass_hat_k, equivalence } from './stats.ts';

let failures = 0;
const check = (n: string, ok: boolean, note = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${note ? ` — ${note}` : ''}`); };

const xs = [0.5, 0.6, 0.55, 0.7, 0.45, 0.62, 0.58, 0.51, 0.66];
const a = bootstrap(xs), b = bootstrap(xs);
check('deterministic', JSON.stringify(a) === JSON.stringify(b));
check('point is the mean', Math.abs(a.point - 0.574) < 0.001, a.point.toFixed(4));
check('interval brackets the point', a.lo < a.point && a.point < a.hi, `${a.lo.toFixed(3)}..${a.hi.toFixed(3)}`);
check('single observation gives a degenerate interval', bootstrap([0.4]).lo === 0.4);
check('empty is empty', bootstrap([]).n === 0);

check('pass^k unbiased, not (c/n)^k', pass_hat_k(5, 9, 2) === (5 / 9) * (4 / 8));
check('pass^k null when k > attempts', pass_hat_k(5, 9, 10) === null);
check('pass^k zero when successes < k', pass_hat_k(1, 9, 2) === 0);
check('pass^1 equals the rate', pass_hat_k(5, 9, 1) === 5 / 9);

const same = bootstrap_diff(xs, xs);
check('identical arms centre on zero', Math.abs(same.point) < 1e-12);
check('identical arms are equivalent at 0.1', equivalence(same, 0.1).verdict === 'equivalent');
const wide = { point: 0, lo: -0.4, hi: 0.4, n: 9 };
check('wide interval is inconclusive, not null', equivalence(wide, 0.05).verdict === 'inconclusive');
const apart = { point: 0.3, lo: 0.1, hi: 0.5, n: 9 };
check('interval excluding zero is different', equivalence(apart, 0.05).verdict === 'different');

// A verdict that n=1 can produce is not a verdict.
check('n=1 yields no verdict', equivalence({ point: 0.024, lo: 0.011, hi: 0.037, n: 1 }, 0.05).verdict === 'insufficient');
check('n=2 yields no verdict', equivalence({ point: 0.017, lo: -0.009, hi: 0.042, n: 2 }, 0.05).verdict === 'insufficient');
check('n at the floor yields a verdict', equivalence({ point: 0, lo: -0.01, hi: 0.01, n: 5 }, 0.05).verdict === 'equivalent');

console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
