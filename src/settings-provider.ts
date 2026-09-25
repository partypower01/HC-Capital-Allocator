/**
 * Where the per-user capital limit comes from.
 *
 * Owner decision 2026-09-25: staff set max trade capital (and the safekill
 * settings) per account in the dashboard admin panel, stored in the shared app DB
 * (sqld) table:
 *
 *   account_risk_settings(
 *     user_id TEXT PRIMARY KEY,
 *     max_trade_capital_usdt REAL,          -- NULL = no trading allowed
 *     safe_buffer_usdt REAL,                -- NOT used by the allocator: it caps how
 *                                           --   much the safekill/re-buy logic may act on
 *                                           --   (HC-Risk-Guardian capital_protection_exits)
 *     safekill_enabled INTEGER NOT NULL DEFAULT 0,
 *     safekill_include_external INTEGER NOT NULL DEFAULT 0,
 *     updated_at TEXT, updated_by TEXT)
 *
 * The allocator only knows `account_id`; it is looked up as `user_id`
 * (1:1 mapping, see README "Per-user capital limit" - open question if a
 * user can own several accounts).
 *
 * Every failure path fails CLOSED (returns null -> no new allocation):
 * no row, NULL max, invalid values, DB error.
 */
import { CapitalLimitsConfig, DEFAULT_MIN_ALLOCATION_USDT, SizingBase, UserCapitalLimit, resolveUserLimit } from './capital-limits.js';

export interface ResolvedUserLimit {
  /**
   * Key the deployed capital is tracked under. The limit is per USER, so a
   * user with several exchange accounts shares one budget.
   */
  user_key: string;
  /** null = no trading allowed (no row, NULL max, invalid, or DB error). */
  limit: UserCapitalLimit | null;
}

export interface RiskSettingsProvider {
  resolve(account_id: string, environment: string): Promise<ResolvedUserLimit>;
}

/** Same shape as hc-db-client's dbQuery (parameterized SELECT -> plain row objects). */
export type DbQueryFn = <T = Record<string, unknown>>(sql: string, args: unknown[]) => Promise<T[]>;

export interface AccountRiskSettingsRow {
  user_id: string;
  max_trade_capital_usdt: number | null;
  safe_buffer_usdt: number | null;
  safekill_enabled: number | boolean;
  safekill_include_external: number | boolean;
  updated_at?: string | null;
  updated_by?: string | null;
}

/**
 * How the allocator's account_id maps to account_risk_settings.user_id:
 *  - 'direct': account_id IS the user_id.
 *  - 'exchange_accounts': account_id is exchange_accounts.id (dashboard
 *    schema) and the user is exchange_accounts.user_id.
 */
export type AccountUserMapping = 'direct' | 'exchange_accounts';

const COLS = 's.user_id, s.max_trade_capital_usdt, s.safe_buffer_usdt, s.safekill_enabled, s.safekill_include_external, s.updated_at, s.updated_by';

export const ACCOUNT_RISK_SETTINGS_SQL: Record<AccountUserMapping, string> = {
  direct: `SELECT ${COLS} FROM account_risk_settings s WHERE s.user_id = ? LIMIT 1`,
  exchange_accounts:
    `SELECT ${COLS} FROM exchange_accounts a JOIN account_risk_settings s ON s.user_id = a.user_id WHERE a.id = ? LIMIT 1`,
};

export interface RowMappingDefaults {
  min_allocation_usdt?: number;
  sizing_base?: SizingBase;
}

const nonNegFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Pure mapping row -> limit. null = no trading allowed for this user. */
export function limitFromRow(row: AccountRiskSettingsRow | undefined | null, defaults: RowMappingDefaults = {}): UserCapitalLimit | null {
  if (!row) return null;
  const max = row.max_trade_capital_usdt;
  if (max === null || max === undefined) return null; // unset = no trading
  if (!nonNegFinite(max)) return null;
  return {
    max_capital_usdt: max,
    min_allocation_usdt: defaults.min_allocation_usdt ?? DEFAULT_MIN_ALLOCATION_USDT,
    sizing_base: defaults.sizing_base ?? 'LIMIT',
  };
}

/** JSON/env config provider (local/paper runs and tests). user_key = account_id. */
export class StaticRiskSettingsProvider implements RiskSettingsProvider {
  constructor(private readonly config: CapitalLimitsConfig) {}
  async resolve(account_id: string, environment: string): Promise<ResolvedUserLimit> {
    return { user_key: account_id, limit: resolveUserLimit(this.config, account_id, environment) };
  }
}

export interface DbProviderOptions extends RowMappingDefaults {
  mapping?: AccountUserMapping;
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Reads account_risk_settings via an injected query function (hc-db-client's
 * dbQuery in production, a fake in tests - tests never touch a real DB).
 * Caches per account for cacheTtlMs (default 30 s) so a burst of
 * ConsensusDecisions does not hammer the DB; staff edits in the dashboard
 * take effect within that TTL. A DB error is never answered from cache.
 */
export class DbRiskSettingsProvider implements RiskSettingsProvider {
  private cache = new Map<string, { at: number; value: ResolvedUserLimit }>();

  constructor(private readonly query: DbQueryFn, private readonly opts: DbProviderOptions = {}) {}

  async resolve(account_id: string, _environment: string): Promise<ResolvedUserLimit> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheTtlMs ?? 30_000;
    const hit = this.cache.get(account_id);
    if (hit && now - hit.at <= ttl) return hit.value;
    try {
      const sql = ACCOUNT_RISK_SETTINGS_SQL[this.opts.mapping ?? 'direct'];
      const rows = await this.query<AccountRiskSettingsRow>(sql, [account_id]);
      const row = rows[0];
      const value: ResolvedUserLimit = {
        user_key: row && typeof row.user_id === 'string' && row.user_id ? row.user_id : account_id,
        limit: limitFromRow(row, this.opts),
      };
      this.cache.set(account_id, { at: now, value });
      return value;
    } catch (err) {
      console.error(`[risk-settings] Failed to read account_risk_settings for ${account_id}, failing closed:`, (err as Error).message);
      this.cache.delete(account_id);
      return { user_key: account_id, limit: null };
    }
  }
}

/** Provider that allows nothing (used when the configured source is unusable). */
export const FAIL_CLOSED_PROVIDER: RiskSettingsProvider = {
  async resolve(account_id: string) {
    return { user_key: account_id, limit: null };
  },
};

/**
 * Build the provider from env:
 *   HC_ALLOCATOR_SETTINGS_SOURCE        'db' (default) | 'config'
 *   HC_ALLOCATOR_ACCOUNT_USER_MAPPING   'direct' (default) | 'exchange_accounts'
 *   HC_ALLOCATOR_SETTINGS_CACHE_MS      cache TTL for DB reads (default 30000)
 *   HC_ALLOCATOR_MIN_ALLOCATION_USDT    minimum allocation for DB-sourced limits (default 5)
 *   HC_ALLOCATOR_SIZING_BASE            'LIMIT' (default) | 'ACCOUNT'
 *   TEAM_DB_URL / TEAM_DB_AUTH_TOKEN    read by hc-db-client itself
 * 'db' loads hc-db-client at runtime (it is a sibling file: package, not a
 * build-time dependency of this repo yet). If it cannot be loaded the
 * service runs FAIL-CLOSED: every new allocation is rejected.
 */
export async function createSettingsProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  importer: (specifier: string) => Promise<unknown> = (s) => import(s),
  loadConfig: (env: Record<string, string | undefined>) => CapitalLimitsConfig = () => ({ accounts: {} }),
): Promise<RiskSettingsProvider> {
  const source = env.HC_ALLOCATOR_SETTINGS_SOURCE ?? 'db';
  if (source === 'config') return new StaticRiskSettingsProvider(loadConfig(env));
  if (source !== 'db') {
    console.error(`[risk-settings] Unknown HC_ALLOCATOR_SETTINGS_SOURCE "${source}": failing closed.`);
    return FAIL_CLOSED_PROVIDER;
  }
  const mappingRaw = env.HC_ALLOCATOR_ACCOUNT_USER_MAPPING ?? 'direct';
  if (mappingRaw !== 'direct' && mappingRaw !== 'exchange_accounts') {
    console.error(`[risk-settings] Unknown HC_ALLOCATOR_ACCOUNT_USER_MAPPING "${mappingRaw}": failing closed.`);
    return FAIL_CLOSED_PROVIDER;
  }
  const sizingRaw = env.HC_ALLOCATOR_SIZING_BASE ?? 'LIMIT';
  if (sizingRaw !== 'LIMIT' && sizingRaw !== 'ACCOUNT') {
    console.error(`[risk-settings] Unknown HC_ALLOCATOR_SIZING_BASE "${sizingRaw}": failing closed.`);
    return FAIL_CLOSED_PROVIDER;
  }
  const cacheMs = Number(env.HC_ALLOCATOR_SETTINGS_CACHE_MS ?? 30_000);
  const minAlloc = Number(env.HC_ALLOCATOR_MIN_ALLOCATION_USDT ?? DEFAULT_MIN_ALLOCATION_USDT);
  try {
    const mod = (await importer('hc-db-client')) as { dbQuery?: DbQueryFn; default?: { dbQuery?: DbQueryFn } };
    const dbQuery = mod.dbQuery ?? mod.default?.dbQuery;
    if (typeof dbQuery !== 'function') throw new Error('hc-db-client has no dbQuery export');
    return new DbRiskSettingsProvider(dbQuery, {
      mapping: mappingRaw,
      cacheTtlMs: Number.isFinite(cacheMs) && cacheMs >= 0 ? cacheMs : 30_000,
      min_allocation_usdt: Number.isFinite(minAlloc) && minAlloc >= 0 ? minAlloc : DEFAULT_MIN_ALLOCATION_USDT,
      sizing_base: sizingRaw,
    });
  } catch (err) {
    console.error('[risk-settings] Cannot load hc-db-client for account_risk_settings, failing closed:', (err as Error).message);
    return FAIL_CLOSED_PROVIDER;
  }
}
