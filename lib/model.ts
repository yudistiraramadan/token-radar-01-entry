// Token Radar value model and farm-plan generator (Node 22, erasable TypeScript, standard library only).
//
//   implied_value = size_value × growth_factor × maturity_factor
//
// size_value      what a token of this TVL and category trades at today: a log-log fit of mcap on TVL
//                 over the snapshot's own priced protocols, scaled by a shrunk per-category multiplier
//                 and clipped to the empirical [0.013, 3.0] × TVL band.
// growth_factor   seven-day TVL momentum: clamp(1 + 2 × change_7d / 100, 0.5, 2.0).
// maturity_factor how long the protocol has run with no token, a step on days since listed_at.
//
// Everything comes from the snapshot's figures; no protocol is named anywhere in this file.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  in_watchlist: boolean;
  base_usd: number;
  growth_mult: number;
  maturity_mult: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface CategoryMult {
  category: string;
  n: number;
  raw: number;
  mult: number;
}

/** Everything the page states about the model, so the header and footer quote the run, not a constant. */
export interface BoardMeta {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: number;
  watchlist: number;
  pre_token: number;
  extras_pool: number;
  extras: number;
  comparables: number;
  fit: { a: number; b: number; scale: number; r2: number };
  clip: { lo: number; hi: number };
  categories: CategoryMult[];
}

export const BOARD_ROWS = 100;
const CLIP_LO = 0.013;
const CLIP_HI = 3.0;
const SHRINK_K = 5;
const MIN_CAT_N = 3;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- input

/** Parse and shape-check the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (typeof s !== 'object' || s === null) throw new Error('snapshot: not a JSON object');
  if (typeof s.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.as_of)) throw new Error('snapshot: as_of is not a UTC date');
  if (!Array.isArray(s.protocols) || !Array.isArray(s.watchlist)) throw new Error('snapshot: protocols and watchlist must be arrays');
  return s;
}

// ---------------------------------------------------------------- helpers

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a[m]!; // upper middle for even n, as the verified preview board was built
}

/** Whole days from listed_at to as_of, or null when DefiLlama records no listing day. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  return Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY_MS);
}

/** A protocol records a token when DefiLlama carries a gecko_id or a symbol for it. */
export const recordsToken = (p: SnapshotProtocol): boolean => p.gecko_id !== null || p.symbol !== null;
export const isPreToken = (p: SnapshotProtocol): boolean => p.gecko_id === null && p.symbol === null;

// ---------------------------------------------------------------- size curve

interface SizeModel {
  a: number;
  b: number;
  r2: number;
  n: number;
  cats: Map<string, CategoryMult>;
}

/** ln(mcap) = a + b·ln(tvl), ordinary least squares on the priced comparables. */
function fitSize(protocols: SnapshotProtocol[]): SizeModel {
  const comps = protocols.filter((p) => p.gecko_id && p.symbol && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const n = comps.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = (sxy * sxy) / (sxx * syy);

  // Per-category multiplier: the median residual ratio, shrunk toward 1 by n / (n + 5).
  const groups = new Map<string, number[]>();
  for (const p of comps) {
    const k = p.category ?? 'Uncategorized';
    const ratio = p.mcap_usd! / Math.exp(a + b * Math.log(p.tvl_usd));
    const g = groups.get(k);
    if (g) g.push(ratio);
    else groups.set(k, [ratio]);
  }
  const cats = new Map<string, CategoryMult>();
  for (const [category, ratios] of groups) {
    if (ratios.length < MIN_CAT_N) continue;
    const raw = median(ratios);
    const w = ratios.length / (ratios.length + SHRINK_K);
    cats.set(category, { category, n: ratios.length, raw, mult: 1 + w * (raw - 1) });
  }
  return { a, b, r2, n, cats };
}

function sizeValue(m: SizeModel, p: SnapshotProtocol): number {
  const base = Math.exp(m.a + m.b * Math.log(p.tvl_usd));
  const mult = m.cats.get(p.category ?? 'Uncategorized')?.mult ?? 1;
  return clamp(base * mult, CLIP_LO * p.tvl_usd, CLIP_HI * p.tvl_usd);
}

// ---------------------------------------------------------------- growth and maturity

export function growthFactor(change7d: number | null): number {
  return change7d === null ? 1 : clamp(1 + (2 * change7d) / 100, 0.5, 2);
}

export function maturityFactor(days: number | null): number {
  if (days === null) return 0.95;
  if (days < 90) return 0.6; // unproven
  if (days < 365) return 0.9; // proving
  if (days < 730) return 1.1; // sweet spot: proven, launch anticipated
  if (days < 1460) return 1.0; // mature
  return 0.85; // stale: long tokenless runs rarely end in a launch
}

// ---------------------------------------------------------------- board composition

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;
const VERSION_SUFFIX = / (V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The watchlist's own cleanliness rule, applied to the pre-token protocols below its floor. */
export function isClean(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (EXCHANGE_PREFIX.some((x) => p.name.startsWith(x))) return false;
  if (DERIVATIVE_WORD.test(p.name)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  return true;
}

export function buildBoard(snap: Snapshot): { rows: BoardRow[]; meta: BoardMeta } {
  const size = fitSize(snap.protocols);
  const watch = new Set(snap.watchlist);

  const score = (p: SnapshotProtocol) => {
    const days = ageDays(snap.as_of, p.listed_at);
    const s = sizeValue(size, p);
    const g = growthFactor(p.change_7d);
    const m = maturityFactor(days);
    return { p, days, s, g, m, v: Math.round(s * g * m) };
  };

  const preToken = snap.protocols.filter(isPreToken);
  const listed = snap.protocols.filter((p) => watch.has(p.slug)).map(score);
  const pool = preToken.filter((p) => !watch.has(p.slug) && isClean(p));
  const extras = pool
    .map(score)
    .sort((x, y) => y.v - x.v || (x.p.slug < y.p.slug ? -1 : 1))
    .slice(0, BOARD_ROWS - listed.length);

  const rows = [...listed, ...extras]
    .sort((x, y) => y.v - x.v || (x.p.slug < y.p.slug ? -1 : 1))
    .map(({ p, days, s, g, m, v }, i): BoardRow => ({
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      in_watchlist: watch.has(p.slug),
      base_usd: Math.round(s),
      growth_mult: Number(g.toFixed(3)),
      maturity_mult: m,
      implied_value_usd: Math.max(1, v),
      farm_steps: farmSteps(p, days),
    }));

  const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  const meta: BoardMeta = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    protocols: snap.protocols.length,
    watchlist: snap.watchlist.length,
    pre_token: preToken.length,
    extras_pool: pool.length,
    extras: extras.length,
    comparables: size.n,
    fit: { a: round(size.a, 3), b: round(size.b, 3), scale: Math.round(Math.exp(size.a)), r2: round(size.r2, 2) },
    clip: { lo: CLIP_LO, hi: CLIP_HI },
    categories: [...size.cats.values()]
      .sort((x, y) => y.n - x.n || (x.category < y.category ? -1 : 1))
      .map((c) => ({ category: c.category, n: c.n, raw: round(c.raw, 2), mult: round(c.mult, 2) })),
  };
  return { rows, meta };
}

// ---------------------------------------------------------------- farm plans

function sizeTier(tvl: number): string {
  if (tvl >= 1e9) return 'mega-cap';
  if (tvl >= 250e6) return 'large';
  if (tvl >= 100e6) return 'mid';
  if (tvl >= 25e6) return 'small';
  return 'micro';
}

function deposit(tvl: number): string {
  if (tvl >= 500e6) return '$2000-10000';
  if (tvl >= 100e6) return '$500-2000';
  if (tvl >= 25e6) return '$200-1000';
  return '$100-500';
}

function ageText(days: number | null): string {
  if (days === null) return 'unknown age';
  return days < 365 ? `${days} days old` : `${(days / 365).toFixed(1)}y old`;
}

function growthText(c: number | null): string {
  if (c === null) return 'flat';
  if (Math.abs(c) < 2) return 'stable';
  return c > 0 ? `growing +${c.toFixed(1)}%` : `declining ${c.toFixed(1)}%`;
}

function chainText(chains: string[]): string {
  if (chains.length === 0) return 'its listed chains';
  if (chains.length === 1) return chains[0]!;
  if (chains.length === 2) return `${chains[0]} and ${chains[1]}`;
  return chains.slice(0, 3).join(', ') + (chains.length > 3 ? ' (+more)' : '');
}

const L2_GAS = ['Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'Avalanche'];
function gasText(chains: string[]): string {
  if (chains.includes('Solana')) return '<$0.01';
  if (chains.some((c) => L2_GAS.includes(c))) return '$0.10-1';
  return '$3-15 on mainnet';
}

const HOLD = 'Hold position 60+ days: airdrops typically snapshot based on cumulative time-weighted TVL. Monitor weekly.';
const EXIT = 'Set alerts: if 7-day TVL change drops below -15%, consider exiting early — likely signals waning momentum.';

/** Five steps: three for the protocol's category (cost, venue, time), then the hold and the exit rule. */
export function farmSteps(p: SnapshotProtocol, days: number | null): string[] {
  const n = p.name;
  const tier = sizeTier(p.tvl_usd);
  const dep = deposit(p.tvl_usd);
  const age = ageText(days);
  const grow = growthText(p.change_7d);
  const chains = chainText(p.chains);
  let head: string[];
  switch (p.category) {
    case 'Risk Curators':
      head = [
        `Open Morpho (app.morpho.org) or Euler/Spark; search for ${n} in the vault/curator list.`,
        'Review current APY (varies 3-12%), fee (typically 10-20% of yield), and asset composition (prefer USDC/wsteth over exotic collateral).',
        `Deposit ${dep} in supported asset; ${tier} curator (${age}, ${grow} TVL).`,
      ];
      break;
    case 'RWA':
      head = [
        `Open ${n}'s official dApp (verify the URL via DefiLlama slug ${p.slug}); complete KYC Tier 2 (24-48h for passport + proof of address).`,
        `Fund via USDC/USDT on ${chains}; gas ${gasText(p.chains)}. Allow 1-2 business days for compliance clearance.`,
        'Subscribe to the primary yield product (Treasury Pool / Private Credit). Expect 4-8% APY on Treasury, 8-14% on credit.',
      ];
      break;
    case 'Onchain Capital Allocator':
      head = [
        `Access ${n} app; most require wallet signature to view strategies (no KYC usually).`,
        'Compare available strategies by target APY, risk tier (low/med/high), and underlying venues.',
        `Deposit ${dep}. ${tier} allocator with ${grow} TVL on ${chains}.`,
      ];
      break;
    case 'CDP':
      head = [
        `Open position with ETH, wstETH, or BTC collateral via ${n}'s mint interface.`,
        'Mint at safe LTV (max 50% of collateral value). Keep health factor > 1.5 at all times.',
        'Deploy minted stablecoin to secondary yield (Pendle PT, Morpho supply, Curve pool) for carry trade.',
      ];
      break;
    case 'Basis Trading':
      head = [
        `Deposit USDC into ${n} vault; funds routed to perp exchanges for delta-neutral position.`,
        'Expect 8-25% APY from funding rate arbitrage; higher when BTC/ETH funding spikes (bull phases).',
        'Lock period usually 7-30 days; some have instant redemption with small fee (0.1-0.3%).',
      ];
      break;
    case 'Lending':
      head = [
        `Supply collateral to ${n} on ${p.chains[0] ?? 'its main chain'}; focus on blue-chip assets (USDC, ETH, WBTC) for best rates.`,
        'Current baseline rates: USDC supply ~3-6%, ETH supply ~1-3%, borrow premiums apply.',
        'Consider borrowing stable against volatile collateral at <40% LTV to amplify position size.',
      ];
      break;
    case 'Dexs':
      head = [
        `Add liquidity to ${n} pools; prefer stable-stable or correlated-asset pairs to minimize IL.`,
        'Target pools with trading volume / TVL ratio > 0.5 (healthy fee generation).',
        'Many new DEXes reward LPs with trading-volume-weighted points — swap small amounts yourself to boost.',
      ];
      break;
    case 'Yield':
      head = [
        `Deposit in ${n} yield vault; ${tier} protocol with ${grow} TVL.`,
        'Compare realized APY vs advertised: deduct protocol fees (typically 10-20% of yield).',
        'Diversify across 2-3 strategies if offered; single-strategy risk = full loss on strategy failure.',
      ];
      break;
    case 'Restaking':
      head = [
        `Deposit LST (wstETH, rETH, cbETH) or native ETH into ${n}.`,
        'Select operator/AVS allocations carefully; higher yield = higher slashing risk.',
        'Expect base restake yield 3-5% on top of native staking 3-4%.',
      ];
      break;
    case 'Chain':
      head = [
        `Bridge assets to ${n} via official bridge; bridge fees typically 0.05-0.2%.`,
        'Provide liquidity on canonical DEX of the chain (usually one dominant AMM).',
        'Transact regularly: swaps, LP, lending — chain airdrops often weight by on-chain activity, not just TVL.',
      ];
      break;
    case 'Payments':
      head = [
        `Set up ${n} wallet/account; some require KYC for fiat ramps.`,
        'Use the payment rails for real transactions (test with $10-50 first).',
        'Many payment protocols reward usage (transactions) over TVL — be an active user.',
      ];
      break;
    case 'Insurance':
      head = [
        `Underwrite coverage on ${n} as liquidity provider; earn premium yield 6-15% typically.`,
        'Diversify across 3+ cover pools to avoid single-event loss.',
        "Claim history matters: check protocol's historical loss ratio before supplying.",
      ];
      break;
    default:
      head = [
        `Visit ${n}'s official site (verify via DefiLlama slug ${p.slug}); connect wallet.`,
        `Deposit ${dep} in the primary product; ${tier} protocol (${age}, ${grow}).`,
        'Hold position 60+ days for airdrop eligibility.',
      ];
  }
  const steps = [...head, HOLD, EXIT];
  for (const s of steps) {
    const len = s.trim().length;
    if (len < 20 || len > 600) throw new Error(`farm step for ${p.slug} is ${len} characters, outside 20-600: ${s}`);
  }
  return steps;
}

// ---------------------------------------------------------------- the gate's own checks

/** The first reason the gate would refuse this board, or null. */
export function boardIssue(rows: BoardRow[], snap: Snapshot): string | null {
  const known = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  if (rows.length < 100 || rows.length > 4000) return `${rows.length} rows, not 100 to 4000`;
  for (const [i, r] of rows.entries()) {
    if (!known.has(r.slug)) return `row ${i}: slug ${r.slug} is not in the snapshot`;
    if (seen.has(r.slug)) return `row ${i}: slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank}, expected ${i + 1}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `row ${i}: implied value ${r.implied_value_usd}`;
    if (i > 0 && r.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i}: implied value rises with rank`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${i}: ${r.farm_steps.length} farm steps`;
  }
  for (const s of snap.watchlist) if (!seen.has(s)) return `watchlist slug ${s} is missing`;
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  return null;
}
