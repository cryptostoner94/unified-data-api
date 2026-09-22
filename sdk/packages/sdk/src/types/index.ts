/**
 * Normalized schemas (§3.5, §2.2).
 *
 * One canonical shape per concept, no matter which upstream served it.
 * EVERY result carries provenance:
 *   - `source`:    which upstream served it (e.g. "binance", "sec-edgar")
 *   - `fetchedAt`: ISO timestamp of the upstream fetch
 *   - `freshness`: "LIVE" | "CACHED" | "ESTIMATE" (§7.1)
 *
 * Rule: a price must never be presented as live when it is cached.
 * `formatPrice()` renders the freshness label by default; hiding it requires
 * the explicit `hideFreshness: true` opt-out.
 */

export type Freshness = "LIVE" | "CACHED" | "ESTIMATE";

/** Provenance carried by every normalized result. */
export interface Provenance {
  /** Which upstream served this result, e.g. "binance", "mempool.space", "sec-edgar". */
  source: string;
  /** ISO-8601 timestamp of the upstream fetch. */
  fetchedAt: string;
  /** §7.1 freshness label. */
  freshness: Freshness;
}

// ---------------------------------------------------------------------------
// Crypto (§3.5)
// ---------------------------------------------------------------------------

export interface Quote extends Provenance {
  symbol: string;
  price: number;
  /** ISO timestamp of the quote itself (may differ from fetchedAt). */
  timestamp: string;
  bid?: number;
  ask?: number;
  /** 24h change percent, when the venue reports it. */
  change24hPct?: number;
  volume24h?: number;
}

export interface Candle extends Provenance {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Venue interval label, e.g. "1m", "1h", "1d". */
  interval: string;
  /** ISO timestamp of the candle open. */
  timestamp: string;
}

export interface OrderBook extends Provenance {
  bids: Array<[price: number, qty: number]>;
  asks: Array<[price: number, qty: number]>;
  timestamp: string;
}

export interface Pair extends Provenance {
  chainId?: string;
  baseToken: string;
  quoteToken: string;
  dex?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24h?: number;
  /** Venue pair identifier (for follow-up lookups). */
  pairId?: string;
}

export interface MempoolTx extends Provenance {
  hash: string;
  feeSatVbyte?: number;
  /** ISO timestamp when first seen. */
  firstSeen: string;
  valueSats?: number;
}

export interface RelayBid extends Provenance {
  /** Beacon slot the bid targets. */
  slot: number | string;
  builder: string;
  /** Bid value in wei (string — exceeds float precision). */
  value: string;
  relay?: string;
}

export interface Trade extends Provenance {
  symbol: string;
  price: number;
  qty: number;
  timestamp: string;
  side?: "buy" | "sell";
}

export interface WalletInfo extends Provenance {
  address: string;
  chain: string;
  balanceSats?: number;
  txCount?: number;
}

export interface WalletTx extends Provenance {
  hash: string;
  address: string;
  valueSats?: number;
  confirmations?: number;
  timestamp?: string;
}

export interface FeeEstimate extends Provenance {
  fastestSatVbyte: number;
  halfHourSatVbyte: number;
  hourSatVbyte: number;
  economySatVbyte: number;
  minimumSatVbyte: number;
}

export interface MempoolStats extends Provenance {
  txCount: number;
  vBytes: number;
  totalFeeSats: number;
  tipHeight?: number;
}

// ---------------------------------------------------------------------------
// Enterprise (§2.2)
// ---------------------------------------------------------------------------

export interface Filing extends Provenance {
  cik: string;
  companyName: string;
  form: string;
  filingDate: string;
  accessionNumber: string;
  documentUrl: string;
}

export interface FinancialFact extends Provenance {
  cik: string;
  concept: string;
  value: number;
  unit: string;
  period: string;
  form?: string;
  filedDate?: string;
}

export interface MacroObservation {
  date: string;
  value: number | null;
}

export interface MacroSeries extends Provenance {
  seriesId: string;
  name: string;
  unit: string;
  observations: MacroObservation[];
}

export interface Patent extends Provenance {
  patentNumber: string;
  title: string;
  assignees: string[];
  inventors: string[];
  filingDate?: string;
  grantDate?: string;
  status?: string;
  cpcCodes: string[];
}

export interface Trademark extends Provenance {
  serialNumber: string;
  mark: string;
  owner: string;
  status: string;
  filingDate?: string;
}

export interface CompanyRecord extends Provenance {
  /** e.g. "uk-companies-house", "opencorporates". */
  registry: string;
  companyNumber: string;
  legalName: string;
  status: string;
  incorporationDate?: string;
  registeredAddress?: string;
  lei?: string;
}

export interface LeiRecord extends Provenance {
  lei: string;
  legalName: string;
  jurisdiction: string;
  legalForm: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Feed-type shared shapes (RSS/Atom, iCal, datasets)
// ---------------------------------------------------------------------------

export interface NewsItem extends Provenance {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
}

export interface CalendarEvent extends Provenance {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
}

export interface TabularData extends Provenance {
  columns: string[];
  rows: string[][];
}

/** Raw GraphQL passthrough for The Graph (DEX subgraphs), with provenance. */
export interface SubgraphResult extends Provenance {
  subgraphId: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Read options shared by every bundle method
// ---------------------------------------------------------------------------

/**
 * Every bundle read accepts `maxAge` (seconds, or Infinity to allow any
 * cached value). Defaults per §7.3: prices 120s, feeds 900s, reference 7d
 * (604800s). When no result satisfies maxAge, the SDK throws StaleData.
 */
export interface ReadOptions {
  maxAge?: number;
  signal?: AbortSignal;
}

/**
 * Render a price with its freshness label attached by default.
 * Suppressing the label requires the explicit `hideFreshness: true` opt-out,
 * so no developer hides staleness by accident (§7.1, §7.5).
 */
export function formatPrice(
  value: number,
  opts: { currency?: string; freshness?: Freshness; hideFreshness?: boolean; decimals?: number } = {},
): string {
  const decimals = opts.decimals ?? 2;
  const body = `${opts.currency ?? ""}${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
  if (opts.hideFreshness || !opts.freshness) return body;
  return `${body} (${opts.freshness})`;
}

/** Human description of a freshness label (for docs/UI). */
export function describeFreshness(f: Freshness): string {
  switch (f) {
    case "LIVE":
      return "Fetched on demand from the upstream in this call (or pushed via a live WebSocket subscription).";
    case "CACHED":
      return "Served from the SDK cache — check fetchedAt for its exact age.";
    case "ESTIMATE":
      return "Derived/indicative value, never a firm quote. Never treat as a tradable price.";
  }
}
