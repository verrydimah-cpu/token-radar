// lib/model.ts — the radar's model: one sealed snapshot in, one ranked board out.
//
// Everything on the board is derived from the snapshot's own figures at run time. No protocol is
// named anywhere in this file: the same functions score every row, and a reader can recompute any
// row's implied value from the factors the board publishes beside it.
//
// The model, in one paragraph. Protocols that already record a token give the market's own
// mcap/TVL ratios; the board takes the median ratio per category (shrunk toward the global median
// when a category has few traded comparables) and applies it to a pre-token protocol's TVL. Three
// small adjustments follow: seven-day TVL momentum, a capped bonus for years run with no token,
// and a capped breadth factor for multi-chain reach. The result is a claim about what a token
// would be worth if the protocol's record stayed as it is — not a prediction that one is issued.
//
// The board's floor is the snapshot's watchlist: all 40 slugs appear, whatever the hygiene filter
// below says about them. Below the floor, the radar adds every clean pre-token protocol at or
// above $5,000,000 of TVL — the early rows the radar exists to find.
//
// Transparency is part of the model, not a garnish: every category ratio carries the names of
// its largest comparables, every row carries a plain-language confidence grade for the set its
// ratio rests on, and every farm plan carries its own totals — the capital its steps deploy,
// the fees they burn, the weeks they run — summed from the same figures the steps state.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The model's version label: the dashboard names it, the board carries it. */
export const MODEL_VERSION = 'radar-3';

/** Below this TVL a pre-token protocol is too small for the board to rank. */
export const BOARD_FLOOR_USD = 5_000_000;

/** A comparable's ratio is clamped into this band before any median is taken. The top of the
 *  band matters most: a ratio past a dozen says more about how a category's TVL is counted
 *  (locked collateral under a market cap, locked tokens under a locker) than about what the
 *  market pays, and one such print must not drag a whole category with it. */
const RATIO_MIN = 0.01;
const RATIO_MAX = 12;

/** A category needs this many traded comparables before its own median is trusted outright;
 *  below it the median is shrunk toward the global one by count. */
const COMPS_TO_TRUST = 3;

/** The adjustment factors' shapes: each is deliberately small and capped, so TVL and the
 *  category ratio do nearly all of the ranking and no factor can manufacture a rank. */
const MOMENTUM_CLAMP = 30; // seven-day change is read at most ±30 per cent
const MOMENTUM_WEIGHT = 0.5; // …and half of that reaches the value
const AGE_BONUS_PER_YEAR = 0.02; // two per cent a year run with no token
const AGE_BONUS_YEARS = 5; // …for at most five years (×1.10)
const CHAIN_BONUS_EACH = 0.01; // one per cent per chain past the first
const CHAIN_BONUS_MAX = 6; // …for at most six extra chains (×1.06)

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to 4 decimal places, for the factors the dashboard prints. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Years a protocol has run, to two decimals; null when the snapshot records no listing date. */
export function ageYears(asOf: string, listedAt: string | null): number | null {
  const days = ageDays(asOf, listedAt);
  return days === null ? null : Math.round((days / 365.25) * 100) / 100;
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ---------------------------------------------------------------------------
// Comparables: what the market already pays for a dollar of TVL, by category.
// ---------------------------------------------------------------------------

/** One category's comparable set: how many traded protocols, their median ratio, the ratio used,
 *  and the largest comparables by market cap, named so a reader can see what the number rests on. */
export interface CategoryRatio {
  category: string;
  comps: number;
  median: number;
  used: number;
  basis: 'category' | 'shrunk' | 'global';
  names: string[];
}

/** The whole comparable table: a global median plus one row per category. */
export interface RatioTable {
  global: number;
  global_comps: number;
  global_names: string[];
  categories: CategoryRatio[];
  byCategory: Map<string, CategoryRatio>;
}

function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** How many comparable names a category row carries: enough to show the set, not the whole set. */
const COMP_NAMES_SHOWN = 4;

/** The largest comparables by market cap, named; market-cap ties break by name, so the list is a
 *  pure function of the snapshot's bytes. */
function topCompNames(comps: { name: string; mcap: number }[]): string[] {
  return [...comps]
    .sort((a, b) => b.mcap - a.mcap || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, COMP_NAMES_SHOWN)
    .map((c) => c.name);
}

/**
 * Build the comparable table from the snapshot's traded protocols. A protocol is a comparable
 * when it records a market cap and a TVL, both positive. Categories with at least COMPS_TO_TRUST
 * comparables speak for themselves; a category with one or two is shrunk toward the global
 * median by count (n parts its own median, the rest the global one), and a category with none —
 * or no category at all — takes the global median.
 */
export function buildRatios(protocols: SnapshotProtocol[]): RatioTable {
  const all: number[] = [];
  const allComps: { name: string; mcap: number }[] = [];
  const perCategory = new Map<string, number[]>();
  const perCategoryComps = new Map<string, { name: string; mcap: number }[]>();
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = clampRatio(p.mcap_usd / p.tvl_usd);
    all.push(r);
    allComps.push({ name: p.name, mcap: p.mcap_usd });
    if (p.category !== null) {
      const list = perCategory.get(p.category);
      if (list === undefined) perCategory.set(p.category, [r]);
      else list.push(r);
      const comps = perCategoryComps.get(p.category);
      if (comps === undefined) perCategoryComps.set(p.category, [{ name: p.name, mcap: p.mcap_usd }]);
      else comps.push({ name: p.name, mcap: p.mcap_usd });
    }
  }
  all.sort((a, b) => a - b);
  const global = medianOf(all);
  const categories: CategoryRatio[] = [];
  const byCategory = new Map<string, CategoryRatio>();
  for (const [category, list] of perCategory) {
    list.sort((a, b) => a - b);
    const med = medianOf(list);
    const n = list.length;
    let used: number;
    let basis: CategoryRatio['basis'];
    if (n >= COMPS_TO_TRUST) {
      used = med;
      basis = 'category';
    } else {
      used = (n * med + (COMPS_TO_TRUST - n) * global) / COMPS_TO_TRUST;
      basis = 'shrunk';
    }
    const row: CategoryRatio = {
      category,
      comps: n,
      median: round4(med),
      used: round4(used),
      basis,
      names: topCompNames(perCategoryComps.get(category) ?? []),
    };
    categories.push(row);
    byCategory.set(category, row);
  }
  categories.sort((a, b) => (a.category < b.category ? -1 : 1));
  return { global: round4(global), global_comps: all.length, global_names: topCompNames(allComps), categories, byCategory };
}

/** The ratio one protocol is valued with, and where it came from. */
export function ratioFor(p: SnapshotProtocol, table: RatioTable): { ratio: number; basis: CategoryRatio['basis']; comps: number } {
  if (p.category !== null) {
    const row = table.byCategory.get(p.category);
    if (row !== undefined) return { ratio: row.used, basis: row.basis, comps: row.comps };
  }
  return { ratio: table.global, basis: 'global', comps: table.global_comps };
}

/** How much weight a row's comparable set can bear, in plain language for the detail view.
 *  A category that speaks for itself with eight or more traded protocols is a strong base; a
 *  handful of comparables, or the broad global median standing in for a silent category, is a
 *  moderate one; a ratio shrunk out of one or two comparables is thin, and the page says so. */
export type CompConfidence = 'strong' | 'moderate' | 'thin';

export function confidenceFor(basis: CategoryRatio['basis'], comps: number): CompConfidence {
  if (basis === 'shrunk') return 'thin';
  if (basis === 'global') return 'moderate';
  return comps >= 8 ? 'strong' : 'moderate';
}

// ---------------------------------------------------------------------------
// Hygiene: which pre-token protocols are products of something else entirely.
// ---------------------------------------------------------------------------

/**
 * The house watchlist rule, restated for the board's own rows. A pre-token record is set aside
 * when it is a wrapped, staked or bridged product, an exchange's own listing, or a versioned
 * duplicate of a protocol that already has its own row:
 *  - its category is Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC
 *    or CEX — the categories whose TVL is another protocol's asset in transit or in custody;
 *  - its name ends in a version marker (a space, then V2, v3, 2.0 and the like), the mark of a
 *    redeploy whose parent protocol carries the real record;
 *  - its name carries the whole word wrapped, staked or staking, in any case;
 *  - its name begins with an exchange's name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX,
 *    Bitfinex or Gemini), the mark of that exchange's own wrapped or staked product.
 * The rule never applies to watchlist slugs: the floor is the floor, and they appear regardless.
 */
const WRAPPER_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_TAIL = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;
const WRAPPER_WORD = /\b(?:wrapped|staked|staking)\b/i;
const EXCHANGE_HEADS = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Why a pre-token protocol is set aside, or null when it is clean. Exported for the model's tests. */
export function hygieneIssue(p: SnapshotProtocol): string | null {
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_TAIL.test(p.name)) return 'versioned duplicate';
  if (WRAPPER_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_HEADS.some((head) => p.name === head || p.name.startsWith(`${head} `))) return 'exchange product';
  return null;
}

/** A protocol the board may rank on its own record: pre-token and clean. */
export function isClean(p: SnapshotProtocol): boolean {
  return isPreToken(p) && hygieneIssue(p) === null;
}

// ---------------------------------------------------------------------------
// The value of one protocol.
// ---------------------------------------------------------------------------

/** The full scoring of one protocol: the value and every factor that produced it. */
export interface Score {
  implied_value_usd: number;
  ratio: number;
  ratio_basis: CategoryRatio['basis'];
  ratio_comps: number;
  momentum_factor: number;
  age_factor: number;
  chain_factor: number;
  age_years: number | null;
}

/** Seven-day momentum: the change clamped to ±30 per cent, half of it reaching the value. */
export function momentumFactor(change7d: number | null): number {
  const c = Math.min(MOMENTUM_CLAMP, Math.max(-MOMENTUM_CLAMP, finite(change7d, 0)));
  return 1 + (c / 100) * MOMENTUM_WEIGHT;
}

/** Tokenless age: two per cent a year, capped at five years; unknown age earns nothing. */
export function ageFactor(years: number | null): number {
  if (years === null) return 1;
  return 1 + Math.min(Math.max(years, 0), AGE_BONUS_YEARS) * AGE_BONUS_PER_YEAR;
}

/** Chain breadth: one per cent per chain past the first, capped at six. */
export function chainFactor(chainCount: number): number {
  return 1 + Math.min(Math.max(chainCount - 1, 0), CHAIN_BONUS_MAX) * CHAIN_BONUS_EACH;
}

/** Score one protocol against the comparable table. */
export function score(p: SnapshotProtocol, table: RatioTable, asOf: string): Score {
  const { ratio, basis, comps } = ratioFor(p, table);
  const years = ageYears(asOf, p.listed_at);
  const momentum = momentumFactor(p.change_7d);
  const age = ageFactor(years);
  const breadth = chainFactor(p.chains.length);
  const raw = p.tvl_usd * ratio * momentum * age * breadth;
  return {
    implied_value_usd: Math.max(1, Math.round(raw)),
    ratio,
    ratio_basis: basis,
    ratio_comps: comps,
    momentum_factor: round4(momentum),
    age_factor: round4(age),
    chain_factor: round4(breadth),
    age_years: years,
  };
}

// ---------------------------------------------------------------------------
// Farm plans: deterministic, seeded by slug, written from category and chains.
// ---------------------------------------------------------------------------

/** FNV-1a over the slug: the seed every per-row choice is drawn from. */
export function hashSlug(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small deterministic PRNG (mulberry32): same seed, same plan, on every run and machine. */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Roughly what one transaction costs on a chain, in dollars, from the chain's name alone. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 14;
  if (c.includes('arbitrum') || c.includes('optimism') || c.includes('base') || c.includes('zksync') || c.includes('linea') || c.includes('scroll') || c.includes('mantle') || c.includes('blast') || c.includes('taiko') || c.includes('mode')) return 0.4;
  if (c.includes('solana')) return 0.05;
  if (c.includes('bsc') || c.includes('bnb') || c.includes('polygon') || c.includes('avalanche') || c.includes('fantom') || c.includes('sonic') || c.includes('tron')) return 0.6;
  return 1.5;
}

/** The capital one farm position carries, tiered by the protocol's own TVL, jittered by seed. */
function capitalFor(p: SnapshotProtocol, rng: () => number): number {
  const base = p.tvl_usd >= 1_000_000_000 ? 400 : p.tvl_usd >= 250_000_000 ? 250 : p.tvl_usd >= 50_000_000 ? 150 : p.tvl_usd >= 10_000_000 ? 75 : 40;
  const jitter = 0.85 + rng() * 0.4;
  return Math.max(10, Math.round((base * jitter) / 5) * 5);
}

/** The working archetype a category names, which chooses the plan's mechanics. */
type Archetype = 'lending' | 'dex' | 'cdp' | 'yield' | 'curator' | 'derivatives' | 'rwa' | 'staking' | 'bridge' | 'launchpad' | 'prediction' | 'generic';

function archetypeOf(p: SnapshotProtocol): Archetype {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('collateral')) return 'lending';
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('dex') || c.includes('liquidity')) return 'dex';
  if (c.includes('curator') || c.includes('allocator')) return 'curator';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('synthetic')) return 'derivatives';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak') || c.includes('staking pool')) return 'staking';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('yield') || c.includes('farm') || c.includes('basis') || c.includes('stable')) return 'yield';
  return 'generic';
}

/** The plan's core action: what the farmer actually does inside the protocol. Two phrasings per
 *  archetype, chosen by the plan's seed, so rows in the same category do not read as one template
 *  with the names swapped. Both phrasings carry the same facts: the capital, the chain, the gas. */
function coreStep(p: SnapshotProtocol, kind: Archetype, capital: number, chain: string, gas: number, v: number): string {
  const n = p.name;
  const g = `$${gas.toFixed(gas < 1 ? 2 : 0)}`;
  const variants: Record<Archetype, [string, string]> = {
    lending: [
      `Supply $${capital} of USDC to ${n} on ${chain} and borrow no more than 30% against it, so the position counts as both supply and borrow activity. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open, then leave it open.`,
      `Lend $${capital} of USDC into ${n} on ${chain}, then borrow against it at no more than 30% loan-to-value, so both sides of the market see the wallet. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open, then leave it open.`,
    ],
    dex: [
      `Add $${capital} of liquidity to ${n}'s busiest pool on ${chain} (the USDC pair, if it lists one) and keep the LP position open rather than hopping pools. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open.`,
      `Provide $${capital} across ${n}'s main USDC pool on ${chain} and leave the position to accrue fees instead of rotating it between pools. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open.`,
    ],
    cdp: [
      `Open a vault in ${n} on ${chain}: deposit $${capital} of collateral and mint its stablecoin at no more than half the maximum ratio, well clear of liquidation. Cost: the $${capital} plus about ${g} of gas. Time: 20 minutes to open and check the health factor.`,
      `Lock $${capital} of collateral in a ${n} vault on ${chain} and draw its stablecoin to at most half the allowed ratio, keeping a wide liquidation buffer. Cost: the $${capital} plus about ${g} of gas. Time: 20 minutes to open and check the health factor.`,
    ],
    curator: [
      `Allocate $${capital} to a ${n} curated vault on ${chain} — pick the vault with the longest track record, not the highest advertised yield. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes, most of it reading the vault's page.`,
      `Place $${capital} with a ${n} curator vault on ${chain}; choose by months of track record and assets already entrusted, not by the headline APY. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes, most of it reading the vault's page.`,
    ],
    derivatives: [
      `Post $${capital} of USDC as margin on ${n} (${chain}) and trade one small hedged position a week — size for activity, not for profit. Cost: the $${capital} plus about ${g} of gas per trade. Time: 20 minutes to set up, 5 minutes a trade.`,
      `Fund a ${n} margin account on ${chain} with $${capital} of USDC and work one small hedged trade a week, sized for a track record rather than a win. Cost: the $${capital} plus about ${g} of gas per trade. Time: 20 minutes to set up, 5 minutes a trade.`,
    ],
    bridge: [
      `Route $${capital} of transfers through ${n} between ${chain} and your main chain, in both directions, instead of using a different bridge each time. Cost: bridge fees near 0.1% plus about ${g} of gas a crossing. Time: 10 minutes a crossing.`,
      `Move $${capital} of volume over ${n} between ${chain} and your main chain across the plan, both ways, rather than splitting crossings between bridges. Cost: bridge fees near 0.1% plus about ${g} of gas a crossing. Time: 10 minutes a crossing.`,
    ],
    staking: [
      `Stake $${capital} of the base asset through ${n} on ${chain} and hold the staking receipt in the same wallet. Cost: the $${capital} plus about ${g} of gas. Time: 10 minutes to stake.`,
      `Delegate $${capital} of the base asset via ${n} on ${chain} and keep the receipt token untouched in the same wallet. Cost: the $${capital} plus about ${g} of gas. Time: 10 minutes to stake.`,
    ],
    rwa: [
      `Mint $${capital} of ${n}'s tokenised asset on ${chain} and hold it; if a secondary market is listed, buy there instead when the mint minimum is higher. Cost: the $${capital} plus about ${g} of gas. Time: 20 minutes including the eligibility check.`,
      `Buy $${capital} of ${n}'s tokenised asset on ${chain} — at the mint if the minimum allows, otherwise on its listed secondary market — and hold it. Cost: the $${capital} plus about ${g} of gas. Time: 20 minutes including the eligibility check.`,
    ],
    launchpad: [
      `Register the wallet on ${n} (${chain}) and take part in one launch with $${capital} at most — never chase an allocation past the amount you set. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to register, then the launch's own window.`,
      `Put at most $${capital} into one ${n} launch on ${chain} from the registered wallet, and let any allocation past that cap go. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to register, then the launch's own window.`,
    ],
    prediction: [
      `Fund $${capital} on ${n} (${chain}) and hold one position in a liquid market until it settles; pick markets you can price, not headlines. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to fund and place.`,
      `Deposit $${capital} on ${n} (${chain}) and take one position in a deep, liquid market you can price yourself, held to settlement. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to fund and place.`,
    ],
    yield: [
      `Deposit $${capital} into ${n}'s flagship vault on ${chain} and take the vault shares, not the auto-compound wrapper, when both are offered. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to deposit.`,
      `Put $${capital} into ${n}'s flagship vault on ${chain}; where a plain share and an auto-compound wrapper are both offered, hold the plain share. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to deposit.`,
    ],
    generic: [
      `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and keep the position open; use the product a regular user would, not a test contract. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open.`,
      `Open a $${capital} USDC position in ${n} on ${chain} through its own app — the flow a regular user takes — and keep it open. Cost: the $${capital} plus about ${g} of gas. Time: 15 minutes to open.`,
    ],
  };
  return variants[kind][v]!;
}

/** The plan's second mechanic: the follow-through that separates a farmer from a one-off visitor.
 *  Two phrasings per archetype, like the core step, chosen by the plan's seed. */
function secondStep(p: SnapshotProtocol, kind: Archetype, capital: number, chain: string, v: number): string {
  const n = p.name;
  const small = Math.max(10, Math.round(capital / 4 / 5) * 5);
  const variants: Record<Archetype, [string, string]> = {
    lending: [
      `Run one careful loop a week: borrow $${small} of a stablecoin against the supply, resupply it once, and unwind it the same day if rates spike. Cost: about $2 of gas a loop. Time: 10 minutes a week.`,
      `Once a week, add a small borrow-and-resupply loop of $${small}, and unwind it the same day if borrowing rates jump. Cost: about $2 of gas a loop. Time: 10 minutes a week.`,
    ],
    dex: [
      `Stake the LP position in ${n}'s own farm or gauge on ${chain} when it offers one, and claim rewards weekly rather than letting them idle. Cost: about $1 of gas a claim. Time: 5 minutes a week.`,
      `If ${n} runs a farm or gauge for the pool on ${chain}, stake the LP there and claim on a weekly rhythm instead of letting rewards idle. Cost: about $1 of gas a claim. Time: 5 minutes a week.`,
    ],
    cdp: [
      `Top the vault up by $${small} whenever its health factor drifts toward your limit, and repay a slice after large price moves. Cost: gas only, about $2 a visit. Time: 5 minutes a check, twice a week.`,
      `Check the vault twice a week: add $${small} of collateral when the health factor thins, and repay a slice after sharp rallies. Cost: gas only, about $2 a visit. Time: 5 minutes a check, twice a week.`,
    ],
    curator: [
      `Split a second $${small} into a different ${n} vault on ${chain} after the first month, so the wallet shows range rather than one lucky deposit. Cost: the $${small} plus gas. Time: 15 minutes.`,
      `After the first month, open a second ${n} vault position of $${small} on ${chain} in a different strategy, so the record shows range rather than one lucky deposit. Cost: the $${small} plus gas. Time: 15 minutes.`,
    ],
    derivatives: [
      `Close and reopen the hedge weekly so the wallet builds a trading history on ${n} across many snapshots, keeping each position under a fifth of the margin. Cost: trading fees near 0.05% a side. Time: 5 minutes a week.`,
      `Rebuild the hedge each week at a slightly different size, keeping every position under a fifth of the margin so ${n} sees steady, ordinary flow. Cost: trading fees near 0.05% a side. Time: 5 minutes a week.`,
    ],
    bridge: [
      `Keep a small balance working on the far side: swap or supply $${small} there through ${n}'s app after each crossing instead of bridging straight back. Cost: about $1 of gas a session. Time: 10 minutes a week.`,
      `Leave working funds on the far side and use them there — a swap or a small supply of $${small} through ${n}'s app — before bridging back. Cost: about $1 of gas a session. Time: 10 minutes a week.`,
    ],
    staking: [
      `Restake or vote the receipt token where ${n} supports it on ${chain}, and claim staking rewards on a fixed day each week. Cost: about $1 of gas a claim. Time: 5 minutes a week.`,
      `Put the receipt token to work where ${n} supports it on ${chain} — restaking or governance — and claim rewards on the same weekday each week. Cost: about $1 of gas a claim. Time: 5 minutes a week.`,
    ],
    rwa: [
      `Add $${small} a month to the same ${n} position so the holding grows across snapshots rather than sitting at the minimum. Cost: the $${small} plus gas. Time: 10 minutes a month.`,
      `Grow the same ${n} holding by $${small} a month rather than opening new positions elsewhere. Cost: the $${small} plus gas. Time: 10 minutes a month.`,
    ],
    launchpad: [
      `Complete every pre-launch task ${n} publishes for the next sale — registration, whitelists, holds — from this wallet only. Cost: gas only, about $2 a task. Time: 10 minutes a task.`,
      `Work through ${n}'s published pre-launch list for the next sale — registration, whitelist, any hold requirement — from this wallet only. Cost: gas only, about $2 a task. Time: 10 minutes a task.`,
    ],
    prediction: [
      `Roll settled winnings into the next position instead of withdrawing, keeping the ${n} balance active across at least three market cycles. Cost: nothing but the settled funds. Time: 10 minutes a cycle.`,
      `Let settled positions roll: winnings fund the next ${n} market, so the balance stays live across at least three cycles. Cost: nothing but the settled funds. Time: 10 minutes a cycle.`,
    ],
    yield: [
      `Harvest and redeposit the vault's rewards monthly on ${chain}, so ${n} records compounding activity rather than a single deposit. Cost: about $1 of gas a harvest. Time: 5 minutes a month.`,
      `Each month, harvest ${n}'s rewards on ${chain} and redeposit them into the same vault, so the record shows compounding rather than a single deposit. Cost: about $1 of gas a harvest. Time: 5 minutes a month.`,
    ],
    generic: [
      `Repeat the core action monthly with about $${small} more, so ${n} sees a returning user across several snapshots. Cost: the $${small} plus gas. Time: 10 minutes a month.`,
      `Return monthly with about $${small} more, so ${n} records a repeat user across several snapshots rather than a single visit. Cost: the $${small} plus gas. Time: 10 minutes a month.`,
    ],
  };
  return variants[kind][v]!;
}

/** A plan's totals, for the detail view's summary line: the capital the steps put to work, the
 *  gas and fees they burn (a range, because gas moves), and the run's length in weeks. The
 *  figures are summed from the same quantities the steps themselves state — the tier capital,
 *  its quarter and half top-ups, the chains' gas — so the summary can never contradict the plan. */
export interface PlanSummary {
  capital_usd: number;
  fees_lo: number;
  fees_hi: number;
  weeks: number;
}

/** One protocol's whole plan: its steps and their totals. */
export interface FarmPlan {
  steps: string[];
  summary: PlanSummary;
}

/**
 * A protocol's farm plan: five or six steps, each with what it costs and how long it takes.
 * The plan is assembled from the protocol's own record — its category's mechanics, its real top
 * chains, a capital tier from its TVL — and seeded by its slug, so two protocols never receive
 * the same text and the same snapshot always produces the same plan. Every step slot carries
 * two or more phrasings and the seed chooses among them, so plans in one category do not read
 * as a single template with the names swapped.
 */
export function farmPlan(p: SnapshotProtocol): FarmPlan {
  const rng = rngFrom(hashSlug(p.slug));
  const kind = archetypeOf(p);
  const capital = capitalFor(p, rng);
  const chains = p.chains.length > 0 ? p.chains : ['its main chain'];
  const first = chains[0]!;
  const second = chains.length > 1 ? chains[1]! : null;
  const gas = gasUsd(first);
  const weeks = intBetween(rng, 6, 12);
  const small = Math.max(10, Math.round(capital / 4 / 5) * 5);
  const half = Math.max(10, Math.round(capital / 2 / 5) * 5);

  const setups = [
    `Start with a fresh wallet funded only with the $${capital + 25} this ${p.name} plan needs, and keep its seed phrase offline. Cost: under $3 to fund. Time: 10 minutes, once.`,
    `Use one dedicated wallet for ${p.name} so its activity is readable on its own; fund it with the $${capital + 25} the plan uses. Cost: under $3 to fund. Time: 10 minutes, once.`,
    `Prepare a clean wallet (no dust from other farms) and move $${capital + 25} into it on ${first} for ${p.name}. Cost: about $${gas.toFixed(gas < 1 ? 2 : 0)} for the transfer. Time: 10 minutes, once.`,
    `Open a fresh wallet for ${p.name} alone, fund it with the $${capital + 25} the plan needs on ${first}, and write the seed phrase down offline. Cost: under $3 to fund. Time: 10 minutes, once.`,
    `Set up one wallet dedicated to ${p.name} and nothing else; move $${capital + 25} into it before you touch the app. Cost: under $3 to fund. Time: 10 minutes, once.`,
  ];
  const coreV = rng() < 0.5 ? 0 : 1;
  const secondV = rng() < 0.5 ? 0 : 1;
  const steps: string[] = [pick(rng, setups), coreStep(p, kind, capital, first, gas, coreV), secondStep(p, kind, capital, first, secondV)];

  if (second !== null) {
    const weekIn = intBetween(rng, 2, 4);
    steps.push(
      pick(rng, [
        `Extend to ${second} in week ${weekIn}: bridge about $${half} over and repeat the core action there, so ${p.name} records the wallet on two chains. Cost: bridge fee near 0.1% plus about $${gasUsd(second).toFixed(2)} of gas. Time: 20 minutes.`,
        `In week ${weekIn}, take the plan to ${second} as well: bridge about $${half} across and repeat the core action, so ${p.name} records the wallet on two chains. Cost: bridge fee near 0.1% plus about $${gasUsd(second).toFixed(2)} of gas. Time: 20 minutes.`,
      ]),
    );
  } else {
    steps.push(
      pick(rng, [
        `Read ${p.name}'s governance forum and docs once a month and vote or comment where a wallet signature is enough; governance readers are the users a launch rewards first. Cost: nothing, or a signature's gas. Time: 15 minutes a month.`,
        `Once a month, read ${p.name}'s docs and governance forum end to end and vote where a signature is enough; launches tend to reward the wallets that were paying attention. Cost: nothing, or a signature's gas. Time: 15 minutes a month.`,
      ]),
    );
  }

  // Most plans carry a points-watch step; about a third skip it, so plans run five or six steps.
  if (rng() >= 0.3) {
    steps.push(
      pick(rng, [
        `Check ${p.name}'s official points or rewards page every week and complete any testnet or quest it opens from this wallet. Cost: never pay a third party to claim anything. Time: 5 minutes a week.`,
        `Watch ${p.name}'s own announcements for a points program; if one opens, register this wallet on the official page only. Cost: nothing to register. Time: 5 minutes a week of checking.`,
        `Keep an eye on ${p.name}'s official channels for a points or rewards program; if one opens, enrol this wallet on the official page only and finish its starter tasks. Cost: nothing to enrol. Time: 5 minutes a week of checking.`,
      ]),
    );
  }

  steps.push(
    pick(rng, [
      `Hold the position for at least ${weeks} weeks so the activity spans several weekly snapshots, then review: keep, grow or unwind, and log every transaction with its date. Cost: the capital stays deployed until you unwind. Time: ${weeks} weeks, 5 minutes a week of checks.`,
      `Stay in for at least ${weeks} weeks so the position appears in several weekly snapshots, checking in for 5 minutes a week; at the end, decide from the log — keep, grow or unwind. Cost: the capital stays deployed until you unwind. Time: ${weeks} weeks.`,
      `Let the position run at least ${weeks} weeks, with a 5-minute check each week and every transaction logged with its date; then review the whole plan before adding or withdrawing anything. Cost: the capital stays deployed until you unwind. Time: ${weeks} weeks.`,
    ]),
  );

  // The summary: capital is what the steps deploy (core, top-up, second chain); fees are what
  // they burn — funding, the core action's gas, a dollar or two of weekly upkeep across the run,
  // and the bridge crossing when the plan extends. Gas moves, so the fees are a range.
  const fees = 3 + gas + 1.5 * weeks + (second !== null ? 0.001 * half + gasUsd(second) : 0);
  const summary: PlanSummary = {
    capital_usd: capital + small + (second !== null ? half : 0),
    fees_lo: Math.max(2, Math.round(fees * 0.75)),
    fees_hi: Math.round(fees * 1.3) + 1,
    weeks,
  };
  return { steps, summary };
}

/** A protocol's farm plan steps, without their totals. */
export function farmSteps(p: SnapshotProtocol): string[] {
  return farmPlan(p).steps;
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

/** One row of board.json: the ranked claim, its evidence, and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    ratio: number;
    ratio_basis: CategoryRatio['basis'];
    ratio_comps: number;
    momentum_factor: number;
    age_factor: number;
    chain_factor: number;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row's fields, flat, plus its farm plan, the
 *  confidence its comparable set earns, and its plan's totals. */
export interface RadarRow extends Omit<BoardRow, 'model'> {
  ratio: number;
  ratio_basis: CategoryRatio['basis'];
  ratio_comps: number;
  momentum_factor: number;
  age_factor: number;
  chain_factor: number;
  confidence: CompConfidence;
  plan: PlanSummary;
}

/** A protocol that already trades: shown apart from the board, at the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  stats: {
    protocols: number;
    with_token: number;
    pre_token: number;
    watchlist: number;
    board_rows: number;
    set_aside: number;
  };
  ratios: {
    global: number;
    global_comps: number;
    global_names: string[];
    categories: CategoryRatio[];
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/**
 * Assemble the board: every watchlist slug, plus every clean pre-token protocol at or above the
 * board floor, scored and ranked by implied value. Ties break by slug, so the ranking is a pure
 * function of the snapshot's bytes.
 */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const table = buildRatios(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter(
    (p) => watch.has(p.slug) || (isClean(p) && p.tvl_usd >= BOARD_FLOOR_USD),
  );
  const scored = chosen.map((p) => ({ p, s: score(p, table, snapshot.as_of) }));
  scored.sort((a, b) => b.s.implied_value_usd - a.s.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_years: s.age_years,
    watchlist: watch.has(p.slug),
    implied_value_usd: s.implied_value_usd,
    model: {
      ratio: s.ratio,
      ratio_basis: s.ratio_basis,
      ratio_comps: s.ratio_comps,
      momentum_factor: s.momentum_factor,
      age_factor: s.age_factor,
      chain_factor: s.chain_factor,
    },
    farm_steps: farmSteps(p),
  }));
}

/** The traded protocols, by market cap, for the dashboard's kept-apart strip. */
export function liveRows(snapshot: Snapshot, limit = 16): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      change_7d: p.change_7d,
    }));
}

/** Everything the entry writes, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const table = buildRatios(snapshot.protocols);
  const preToken = snapshot.protocols.filter(isPreToken).length;
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    stats: {
      protocols: snapshot.protocols.length,
      with_token: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
      pre_token: preToken,
      watchlist: snapshot.watchlist.length,
      board_rows: board.length,
      set_aside: preToken - board.length,
    },
    ratios: { global: table.global, global_comps: table.global_comps, global_names: table.global_names, categories: table.categories },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_years: r.age_years,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      ratio: r.model.ratio,
      ratio_basis: r.model.ratio_basis,
      ratio_comps: r.model.ratio_comps,
      momentum_factor: r.model.momentum_factor,
      age_factor: r.model.age_factor,
      chain_factor: r.model.chain_factor,
      confidence: confidenceFor(r.model.ratio_basis, r.model.ratio_comps),
      plan: farmPlan(bySlug.get(r.slug)!).summary,
      farm_steps: r.farm_steps,
    })),
    live: liveRows(snapshot),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outvalues rank ${i}`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
