/**
 * Per-user (per-account) trading capital limits.
 *
 * Owner decision 2026-09-25: "If I want to trade with max 100, the software
 * must track that itself." Each account gets a configurable maximum amount
 * of capital (USDT) the software may have deployed at any time.
 *
 * Identity: the allocator only ever sees `account_id` + `environment` on a
 * ConsensusDecision / PortfolioState, so the account_id is the "user" here.
 * A limit can be set per account (all environments) or per
 * `account_id:environment` (takes precedence).
 *
 * SAFE DEFAULT: an account without a configured limit (and no explicit
 * `default` entry) gets NO new allocations. We fail closed, never open.
 *
 * In production the limits come from the dashboard's account_risk_settings
 * table (see settings-provider.ts, HC_ALLOCATOR_SETTINGS_SOURCE=db, the
 * default). This JSON config is the alternative for local/paper runs and tests
 * (HC_ALLOCATOR_SETTINGS_SOURCE=config).
 *
 * Config source (read once at service start, see loadCapitalLimitsFromEnv):
 *   HC_ALLOCATOR_CAPITAL_LIMITS_FILE  path to a JSON file, or
 *   HC_ALLOCATOR_CAPITAL_LIMITS       the same JSON inline.
 * Shape:
 *   {
 *     "default": { "max_capital_usdt": 0 },            // optional
 *     "accounts": {
 *       "acc-justin":      { "max_capital_usdt": 100 },
 *       "acc-justin:LIVE": { "max_capital_usdt": 100, "min_allocation_usdt": 5 }
 *     }
 *   }
 * Invalid config -> every account is treated as unconfigured (fail closed).
 */
import { readFileSync } from 'node:fs';

export type SizingBase = 'LIMIT' | 'ACCOUNT';

export interface UserCapitalLimit {
  /** Max USDT the software may have deployed for this account at once. */
  max_capital_usdt: number;
  /** Smallest allocation worth sending on (exchange minimum etc.). Default 5. */
  min_allocation_usdt?: number;
  /**
   * What the sizing-matrix percentage is taken of:
   *  - 'LIMIT' (default): of min(account AUM, max_capital_usdt), i.e. the
   *    limit is treated as the user's trading capital (3% of 100 = 3 USDT).
   *  - 'ACCOUNT': of the full account AUM, then capped by remaining room.
   */
  sizing_base?: SizingBase;
}

export interface CapitalLimitsConfig {
  default?: UserCapitalLimit;
  accounts: Record<string, UserCapitalLimit>;
}

export const DEFAULT_MIN_ALLOCATION_USDT = 5;

export const EMPTY_LIMITS: CapitalLimitsConfig = { accounts: {} };

function isValidLimit(v: unknown): v is UserCapitalLimit {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.max_capital_usdt !== 'number' || !Number.isFinite(o.max_capital_usdt) || o.max_capital_usdt < 0) return false;
  if (o.min_allocation_usdt !== undefined &&
      (typeof o.min_allocation_usdt !== 'number' || !Number.isFinite(o.min_allocation_usdt) || o.min_allocation_usdt < 0)) return false;
  if (o.sizing_base !== undefined && o.sizing_base !== 'LIMIT' && o.sizing_base !== 'ACCOUNT') return false;
  return true;
}

/** Parse + validate. Throws on any invalid entry (caller decides to fail closed). */
export function parseCapitalLimits(json: string): CapitalLimitsConfig {
  const raw = JSON.parse(json) as unknown;
  if (!raw || typeof raw !== 'object') throw new Error('capital limits: root must be an object');
  const r = raw as Record<string, unknown>;
  const accounts: Record<string, UserCapitalLimit> = {};
  const rawAccounts = r.accounts ?? {};
  if (typeof rawAccounts !== 'object' || rawAccounts === null || Array.isArray(rawAccounts)) {
    throw new Error('capital limits: "accounts" must be an object');
  }
  for (const [key, val] of Object.entries(rawAccounts as Record<string, unknown>)) {
    if (!isValidLimit(val)) throw new Error(`capital limits: invalid entry for "${key}"`);
    accounts[key] = { ...val };
  }
  let def: UserCapitalLimit | undefined;
  if (r.default !== undefined) {
    if (!isValidLimit(r.default)) throw new Error('capital limits: invalid "default" entry');
    def = { ...r.default };
  }
  return def ? { default: def, accounts } : { accounts };
}

/**
 * Load from env. Never throws: on a missing or invalid config it logs and
 * returns EMPTY_LIMITS, which makes every account unconfigured -> rejected.
 */
export function loadCapitalLimitsFromEnv(env: Record<string, string | undefined> = process.env): CapitalLimitsConfig {
  try {
    const file = env.HC_ALLOCATOR_CAPITAL_LIMITS_FILE;
    const inline = env.HC_ALLOCATOR_CAPITAL_LIMITS;
    const text = file ? readFileSync(file, 'utf8') : inline;
    if (!text) {
      console.warn('[capital-limits] No HC_ALLOCATOR_CAPITAL_LIMITS(_FILE) set: no account has a limit, all new allocations will be rejected.');
      return EMPTY_LIMITS;
    }
    const cfg = parseCapitalLimits(text);
    console.log(`[capital-limits] Loaded limits for ${Object.keys(cfg.accounts).length} account key(s)${cfg.default ? ' + default' : ''}.`);
    return cfg;
  } catch (err) {
    console.error('[capital-limits] Invalid capital limits config, failing closed (all new allocations rejected):', (err as Error).message);
    return EMPTY_LIMITS;
  }
}

/** `account_id:environment` beats `account_id` beats `default`; else null (= no new allocation). */
export function resolveUserLimit(
  config: CapitalLimitsConfig,
  account_id: string,
  environment: string,
): UserCapitalLimit | null {
  return config.accounts[`${account_id}:${environment}`]
    ?? config.accounts[account_id]
    ?? config.default
    ?? null;
}
