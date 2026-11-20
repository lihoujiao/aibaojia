import { Pool, type PoolClient, type QueryResultRow } from "pg";

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("必须设置 DATABASE_URL，并且指向 PostgreSQL。本轮不再使用 SQLite。");
  }
  if (/sqlite/i.test(url)) {
    throw new Error("DATABASE_URL 不能是 SQLite。测试和预览都要连接 PostgreSQL。");
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error("DATABASE_URL 必须是 PostgreSQL 连接串。");
  }
  return url;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl(), max: 8 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

export async function query<T extends QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(db, sql, params);
  return rows[0] ?? null;
}

export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query(sql, params);
  return result.rowCount ?? 0;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  } finally {
    client.release();
  }
}

export class DomainFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export async function migrate(db: Db = getPool()): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key text PRIMARY KEY,
      value text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id text PRIMARY KEY,
      name text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id text PRIMARY KEY,
      name text NOT NULL,
      group_id text REFERENCES groups(id),
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      role text NOT NULL CHECK (role IN ('merchant', 'group', 'platform', 'customer_service')),
      merchant_id text REFERENCES merchants(id),
      group_id text REFERENCES groups(id),
      phone text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_requests (
      id text PRIMARY KEY,
      phone_hash text NOT NULL,
      ip text,
      created_at timestamptz NOT NULL,
      challenge_id text
    );

    CREATE INDEX IF NOT EXISTS otp_requests_phone_idx ON otp_requests (phone_hash, created_at);
    CREATE INDEX IF NOT EXISTS otp_requests_ip_idx ON otp_requests (ip, created_at);

    CREATE TABLE IF NOT EXISTS otp_challenges (
      id text PRIMARY KEY,
      phone text NOT NULL,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL
    );

    CREATE INDEX IF NOT EXISTS otp_challenges_phone_idx ON otp_challenges (phone, created_at DESC);

    CREATE TABLE IF NOT EXISTS products (
      id text PRIMARY KEY,
      merchant_id text NOT NULL REFERENCES merchants(id),
      name text NOT NULL,
      note text,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_units (
      id text PRIMARY KEY,
      product_id text NOT NULL REFERENCES products(id),
      unit_label text NOT NULL,
      is_base boolean NOT NULL,
      to_base_numerator integer NOT NULL CHECK (to_base_numerator > 0),
      to_base_denominator integer NOT NULL CHECK (to_base_denominator > 0),
      UNIQUE (product_id, unit_label)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS product_one_base_idx ON product_units (product_id) WHERE is_base;

    CREATE TABLE IF NOT EXISTS skus (
      id text PRIMARY KEY,
      product_id text NOT NULL REFERENCES products(id),
      merchant_id text NOT NULL REFERENCES merchants(id),
      spec_name text NOT NULL,
      note text,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory (
      sku_id text PRIMARY KEY REFERENCES skus(id),
      on_hand_base integer NOT NULL CHECK (on_hand_base >= 0),
      reserved_base integer NOT NULL CHECK (reserved_base >= 0),
      CHECK (reserved_base <= on_hand_base)
    );

    CREATE TABLE IF NOT EXISTS merchant_commission (
      merchant_id text PRIMARY KEY REFERENCES merchants(id),
      merchant_bps integer CHECK (merchant_bps IS NULL OR (merchant_bps > 0 AND merchant_bps <= 10000)),
      platform_bps integer CHECK (platform_bps IS NULL OR (platform_bps > 0 AND platform_bps <= 10000)),
      merchant_updated_by text,
      merchant_updated_by_name text,
      merchant_updated_at timestamptz,
      platform_updated_by text,
      platform_updated_by_name text,
      platform_updated_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS commission_audit (
      id text PRIMARY KEY,
      merchant_id text NOT NULL,
      side text NOT NULL CHECK (side IN ('merchant', 'platform')),
      previous_bps integer,
      new_bps integer NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_timeout_config (
      merchant_id text PRIMARY KEY REFERENCES merchants(id),
      duration_value integer NOT NULL CHECK (duration_value > 0),
      duration_unit text NOT NULL CHECK (duration_unit IN ('minute', 'hour', 'day')),
      updated_by text NOT NULL,
      updated_by_name text NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounding_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      mode text NOT NULL CHECK (mode = 'half_up'),
      rule_label text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id text PRIMARY KEY,
      sku_id text NOT NULL REFERENCES skus(id),
      merchant_id text NOT NULL,
      floor_price_cents integer NOT NULL CHECK (floor_price_cents >= 0),
      valid_from timestamptz NOT NULL,
      valid_until timestamptz NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL,
      note text
    );

    CREATE INDEX IF NOT EXISTS quotes_sku_idx ON quotes (sku_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS inbound_docs (
      id text PRIMARY KEY,
      merchant_id text NOT NULL,
      sku_id text NOT NULL,
      product_id text NOT NULL,
      qty_in_unit integer NOT NULL CHECK (qty_in_unit > 0),
      unit_id text NOT NULL,
      unit_label text NOT NULL,
      to_base_numerator integer NOT NULL,
      to_base_denominator integer NOT NULL,
      qty_base integer NOT NULL CHECK (qty_base > 0),
      rounding_mode text NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      note text,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id text PRIMARY KEY,
      merchant_id text NOT NULL,
      sku_id text NOT NULL,
      product_id text NOT NULL,
      buyer_label text NOT NULL,
      qty_in_unit integer NOT NULL CHECK (qty_in_unit > 0),
      unit_id text NOT NULL,
      unit_label text NOT NULL,
      to_base_numerator integer NOT NULL,
      to_base_denominator integer NOT NULL,
      qty_base integer NOT NULL CHECK (qty_base > 0),
      rounding_mode text NOT NULL,
      quote_id text NOT NULL,
      floor_price_cents integer NOT NULL,
      line_floor_cents integer NOT NULL,
      commission_bps integer NOT NULL,
      commission_cents integer NOT NULL,
      platform_price_cents integer NOT NULL,
      qty_fulfilled_base integer NOT NULL DEFAULT 0 CHECK (qty_fulfilled_base >= 0),
      status text NOT NULL CHECK (status IN ('reserved', 'fulfilled', 'cancelled', 'timed_out')),
      idempotency_key text NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      created_at timestamptz NOT NULL,
      fulfilled_at timestamptz,
      UNIQUE (merchant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS outbound_docs (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      merchant_id text NOT NULL,
      sku_id text NOT NULL,
      qty_base integer NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (merchant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id text PRIMARY KEY,
      merchant_id text NOT NULL,
      sku_id text NOT NULL,
      movement_type text NOT NULL CHECK (movement_type IN ('purchase_in', 'order_reserve', 'sale_out', 'reserve_release')),
      qty_base_delta integer NOT NULL,
      reserved_delta integer NOT NULL,
      on_hand_after integer NOT NULL,
      reserved_after integer NOT NULL,
      available_after integer NOT NULL,
      unit_label text NOT NULL,
      qty_in_unit integer,
      to_base_numerator integer,
      to_base_denominator integer,
      rounding_mode text,
      ref_doc_type text NOT NULL,
      ref_doc_id text NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      note text NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ledger_sku_idx ON ledger (sku_id, created_at DESC);
  `);
  await db.query(`
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS merchant_bps integer;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS platform_bps integer;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS merchant_updated_by text;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS merchant_updated_by_name text;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS merchant_updated_at timestamptz;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS platform_updated_by text;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS platform_updated_by_name text;
    ALTER TABLE merchant_commission ADD COLUMN IF NOT EXISTS platform_updated_at timestamptz;
    ALTER TABLE merchant_commission DROP CONSTRAINT IF EXISTS merchant_commission_merchant_bps_check;
    ALTER TABLE merchant_commission DROP CONSTRAINT IF EXISTS merchant_commission_platform_bps_check;
    ALTER TABLE merchant_commission ADD CONSTRAINT merchant_commission_merchant_bps_check CHECK (merchant_bps IS NULL OR (merchant_bps > 0 AND merchant_bps <= 10000));
    ALTER TABLE merchant_commission ADD CONSTRAINT merchant_commission_platform_bps_check CHECK (platform_bps IS NULL OR (platform_bps > 0 AND platform_bps <= 10000));
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qty_fulfilled_base integer NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS timeout_duration_value integer;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS timeout_duration_unit text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS timeout_at timestamptz;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS timeout_judge_source text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS timeout_judged_at timestamptz;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_timeout_unit_check;
    ALTER TABLE orders ADD CONSTRAINT orders_timeout_unit_check CHECK (timeout_duration_unit IS NULL OR timeout_duration_unit IN ('minute', 'hour', 'day'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_timeout_value_check;
    ALTER TABLE orders ADD CONSTRAINT orders_timeout_value_check CHECK (timeout_duration_value IS NULL OR timeout_duration_value > 0);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_timeout_source_check;
    ALTER TABLE orders ADD CONSTRAINT orders_timeout_source_check CHECK (timeout_judge_source IS NULL OR timeout_judge_source IN ('automatic', 'event'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('reserved', 'fulfilled', 'cancelled', 'timed_out'));
    ALTER TABLE outbound_docs DROP CONSTRAINT IF EXISTS outbound_docs_order_id_key;
    ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_movement_type_check;
    ALTER TABLE ledger ADD CONSTRAINT ledger_movement_type_check CHECK (movement_type IN ('purchase_in', 'order_reserve', 'sale_out', 'reserve_release'));
    ALTER TABLE commission_audit ADD COLUMN IF NOT EXISTS side text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS term_days integer;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS capital_cost_annual_bps integer;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS overdue_annual_bps integer;
    ALTER TABLE orders ALTER COLUMN capital_cost_annual_bps TYPE numeric(12,2) USING capital_cost_annual_bps::numeric(12,2);
    ALTER TABLE orders ALTER COLUMN overdue_annual_bps TYPE numeric(12,2) USING overdue_annual_bps::numeric(12,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS capital_cost_annual_percent numeric(8,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS overdue_annual_percent numeric(8,2);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_capital_cost_percent_check;
    ALTER TABLE orders ADD CONSTRAINT orders_capital_cost_percent_check CHECK (capital_cost_annual_percent IS NULL OR (capital_cost_annual_percent >= 0 AND capital_cost_annual_percent <= 10000 AND scale(capital_cost_annual_percent) <= 2));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_overdue_percent_check;
    ALTER TABLE orders ADD CONSTRAINT orders_overdue_percent_check CHECK (overdue_annual_percent IS NULL OR (overdue_annual_percent >= 0 AND overdue_annual_percent <= 10000 AND scale(overdue_annual_percent) <= 2));
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS agreement_price_cents integer;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS agreement_price_source text;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS principal_cents integer;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS principal_paid_cents integer NOT NULL DEFAULT 0;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IS NULL OR payment_method IN ('cash', 'barter', 'term'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_term_days_check;
    ALTER TABLE orders ADD CONSTRAINT orders_term_days_check CHECK (term_days IS NULL OR term_days > 0);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_capital_cost_bps_check;
    ALTER TABLE orders ADD CONSTRAINT orders_capital_cost_bps_check CHECK (capital_cost_annual_bps IS NULL OR (capital_cost_annual_bps >= 0 AND capital_cost_annual_bps <= 1000000 AND scale(capital_cost_annual_bps) <= 2));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_overdue_bps_check;
    ALTER TABLE orders ADD CONSTRAINT orders_overdue_bps_check CHECK (overdue_annual_bps IS NULL OR (overdue_annual_bps >= 0 AND overdue_annual_bps <= 1000000 AND scale(overdue_annual_bps) <= 2));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_agreement_source_check;
    ALTER TABLE orders ADD CONSTRAINT orders_agreement_source_check CHECK (agreement_price_source IS NULL OR agreement_price_source IN ('order_time_explicit'));
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_agreement_cents_check;
    ALTER TABLE orders ADD CONSTRAINT orders_agreement_cents_check CHECK (agreement_price_cents IS NULL OR agreement_price_cents >= 0);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_principal_check;
    ALTER TABLE orders ADD CONSTRAINT orders_principal_check CHECK (principal_cents IS NULL OR principal_cents >= 0);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_principal_paid_check;
    ALTER TABLE orders ADD CONSTRAINT orders_principal_paid_check CHECK (principal_paid_cents >= 0);

    CREATE TABLE IF NOT EXISTS shipment_batches (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      merchant_id text NOT NULL,
      outbound_doc_id text NOT NULL UNIQUE,
      qty_base integer NOT NULL CHECK (qty_base > 0),
      ship_date date NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repayments (
      id text PRIMARY KEY,
      order_id text NOT NULL REFERENCES orders(id),
      merchant_id text NOT NULL,
      idempotency_key text NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents > 0),
      applied_principal_cents integer NOT NULL CHECK (applied_principal_cents >= 0),
      unallocated_cents integer NOT NULL CHECK (unallocated_cents >= 0),
      paid_on date NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (merchant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS payment_audit (
      id text PRIMARY KEY,
      merchant_id text NOT NULL,
      order_id text NOT NULL,
      action text NOT NULL,
      actor_user_id text NOT NULL,
      actor_name text NOT NULL,
      note text NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeout_judge_events (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      merchant_id text NOT NULL,
      source text NOT NULL CHECK (source IN ('automatic', 'event')),
      released_base integer NOT NULL CHECK (released_base >= 0),
      created_at timestamptz NOT NULL
    );

    CREATE INDEX IF NOT EXISTS timeout_judge_order_idx ON timeout_judge_events (order_id, created_at);

    CREATE TABLE IF NOT EXISTS otp_verify_attempts (
      id text PRIMARY KEY,
      phone_hash text NOT NULL,
      success boolean NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE INDEX IF NOT EXISTS otp_verify_phone_idx ON otp_verify_attempts (phone_hash, created_at);

    CREATE TABLE IF NOT EXISTS sms_events (
      id text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('send_acceptance', 'verify_result')),
      phone_hash text NOT NULL,
      provider text NOT NULL,
      out_id text,
      acceptance_code text,
      acceptance_success boolean,
      request_id text,
      biz_id text,
      verify_result text,
      created_at timestamptz NOT NULL
    );
  `);
  await db.query(
    `INSERT INTO rounding_settings (id, mode, rule_label)
     VALUES (1, 'half_up', $1)
     ON CONFLICT (id) DO NOTHING`,
    [
      "建议：换算到基准单位时四舍五入到整数。历史单据保存当时的模式和结果。",
    ],
  );
}
