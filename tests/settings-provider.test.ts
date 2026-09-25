// No real DB anywhere in here: the DB provider gets a fake query function.
import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_RISK_SETTINGS_SQL,
  DbRiskSettingsProvider,
  FAIL_CLOSED_PROVIDER,
  StaticRiskSettingsProvider,
  createSettingsProviderFromEnv,
  limitFromRow,
  type AccountRiskSettingsRow,
  type DbQueryFn,
} from '../src/settings-provider.js';

function row(overrides: Partial<AccountRiskSettingsRow> = {}): AccountRiskSettingsRow {
  return {
    user_id: 'user-1',
    max_trade_capital_usdt: 100,
    safe_buffer_usdt: 50,
    safekill_enabled: 0,
    safekill_include_external: 0,
    updated_at: '2026-09-25T10:00:00Z',
    updated_by: 'staff-1',
    ...overrides,
  };
}

function fakeDb(rows: AccountRiskSettingsRow[] | (() => never)) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const q: DbQueryFn = async <T,>(sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    if (typeof rows === 'function') rows();
    return rows as unknown as T[];
  };
  return { q, calls };
}

describe('limitFromRow', () => {
  test('maps max, with defaults for min and sizing base; safe_buffer_usdt is not an allocator limit', () => {
    expect(limitFromRow(row())).toEqual({ max_capital_usdt: 100, min_allocation_usdt: 5, sizing_base: 'LIMIT' });
    expect(limitFromRow(row({ safe_buffer_usdt: 99_999 }))).toEqual(limitFromRow(row({ safe_buffer_usdt: null })));
    expect(limitFromRow(row(), { min_allocation_usdt: 1, sizing_base: 'ACCOUNT' })).toMatchObject({ min_allocation_usdt: 1, sizing_base: 'ACCOUNT' });
  });

  test('NULL max_trade_capital_usdt = no trading allowed', () => {
    expect(limitFromRow(row({ max_trade_capital_usdt: null }))).toBeNull();
  });

  test('no row = no trading allowed', () => {
    expect(limitFromRow(undefined)).toBeNull();
    expect(limitFromRow(null)).toBeNull();
  });

  test.each([
    { max_trade_capital_usdt: -1 },
    { max_trade_capital_usdt: NaN },
    { max_trade_capital_usdt: '100' as unknown as number },
  ])('invalid values fail closed: %p', (o) => {
    expect(limitFromRow(row(o))).toBeNull();
  });
});

describe('DbRiskSettingsProvider (fake query fn)', () => {
  test("'direct' mapping queries account_risk_settings by user_id = account_id, parameterized", async () => {
    const { q, calls } = fakeDb([row({ user_id: 'acc-1' })]);
    const p = new DbRiskSettingsProvider(q);
    const r = await p.resolve('acc-1', 'LIVE');
    expect(r.user_key).toBe('acc-1');
    expect(r.limit?.max_capital_usdt).toBe(100);
    expect(calls).toEqual([{ sql: ACCOUNT_RISK_SETTINGS_SQL.direct, args: ['acc-1'] }]);
    expect(calls[0]!.sql).not.toContain('acc-1');
  });

  test("'exchange_accounts' mapping joins via exchange_accounts.user_id and tracks per user", async () => {
    const { q, calls } = fakeDb([row({ user_id: 'user-9' })]);
    const p = new DbRiskSettingsProvider(q, { mapping: 'exchange_accounts' });
    const r = await p.resolve('exch-acc-3', 'LIVE');
    expect(r.user_key).toBe('user-9');
    expect(calls[0]!.sql).toBe(ACCOUNT_RISK_SETTINGS_SQL.exchange_accounts);
    expect(calls[0]!.sql).toContain('JOIN account_risk_settings');
  });

  test('no row -> limit null, keyed by account', async () => {
    const { q } = fakeDb([]);
    expect(await new DbRiskSettingsProvider(q).resolve('acc-x', 'LIVE')).toEqual({ user_key: 'acc-x', limit: null });
  });

  test('DB error -> fail closed, and the error is not cached', async () => {
    let fail = true;
    const q: DbQueryFn = async <T,>() => {
      if (fail) throw new Error('sqld down');
      return [row()] as unknown as T[];
    };
    const p = new DbRiskSettingsProvider(q, { cacheTtlMs: 60_000 });
    expect((await p.resolve('acc-1', 'LIVE')).limit).toBeNull();
    fail = false;
    expect((await p.resolve('acc-1', 'LIVE')).limit?.max_capital_usdt).toBe(100);
  });

  test('caches within TTL, re-reads after it (staff edits take effect)', async () => {
    let t = 0;
    let max = 100;
    let n = 0;
    const q: DbQueryFn = async <T,>() => {
      n++;
      return [row({ max_trade_capital_usdt: max })] as unknown as T[];
    };
    const p = new DbRiskSettingsProvider(q, { cacheTtlMs: 1_000, now: () => t });
    expect((await p.resolve('acc-1', 'LIVE')).limit?.max_capital_usdt).toBe(100);
    max = 250;
    t = 999;
    expect((await p.resolve('acc-1', 'LIVE')).limit?.max_capital_usdt).toBe(100);
    t = 1_001;
    expect((await p.resolve('acc-1', 'LIVE')).limit?.max_capital_usdt).toBe(250);
    expect(n).toBe(2);
  });
});

describe('createSettingsProviderFromEnv', () => {
  const okImporter = async () => ({ dbQuery: fakeDb([row()]).q });

  test("default source is 'db' via hc-db-client", async () => {
    const p = await createSettingsProviderFromEnv({}, okImporter);
    expect(p).toBeInstanceOf(DbRiskSettingsProvider);
    expect((await p.resolve('user-1', 'LIVE')).limit?.max_capital_usdt).toBe(100);
  });

  test('hc-db-client not loadable -> fail closed', async () => {
    const p = await createSettingsProviderFromEnv({}, async () => {
      throw new Error('Cannot find module');
    });
    expect(p).toBe(FAIL_CLOSED_PROVIDER);
    expect((await p.resolve('user-1', 'LIVE')).limit).toBeNull();
  });

  test('module without dbQuery -> fail closed', async () => {
    expect(await createSettingsProviderFromEnv({}, async () => ({}))).toBe(FAIL_CLOSED_PROVIDER);
  });

  test.each([
    { HC_ALLOCATOR_SETTINGS_SOURCE: 'yaml' },
    { HC_ALLOCATOR_ACCOUNT_USER_MAPPING: 'guess' },
    { HC_ALLOCATOR_SIZING_BASE: 'HALF' },
  ])('unknown option %p -> fail closed', async (env) => {
    expect(await createSettingsProviderFromEnv(env, okImporter)).toBe(FAIL_CLOSED_PROVIDER);
  });

  test("'config' source uses the JSON config provider", async () => {
    const p = await createSettingsProviderFromEnv({ HC_ALLOCATOR_SETTINGS_SOURCE: 'config' }, okImporter, () => ({
      accounts: { a: { max_capital_usdt: 7 } },
    }));
    expect(p).toBeInstanceOf(StaticRiskSettingsProvider);
    expect(await p.resolve('a', 'LIVE')).toEqual({ user_key: 'a', limit: { max_capital_usdt: 7 } });
  });
});
