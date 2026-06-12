import { env } from "@hootifactory/config";
import { SQL } from "bun";

export interface CreateDatabaseClientOptions {
  connection?: Partial<{
    statement_timeout: string;
    idle_in_transaction_session_timeout: string;
  }>;
}

export function createDatabaseClient(opts: CreateDatabaseClientOptions = {}): SQL {
  return new SQL({
    url: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeout: env.DATABASE_POOL_IDLE_TIMEOUT_SECONDS,
    maxLifetime: env.DATABASE_POOL_MAX_LIFETIME_SECONDS,
    connectionTimeout: env.DATABASE_POOL_CONNECTION_TIMEOUT_SECONDS,
    connection: {
      statement_timeout: `${env.DATABASE_STATEMENT_TIMEOUT_MS}ms`,
      idle_in_transaction_session_timeout: `${env.DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS}ms`,
      ...opts.connection,
    },
  });
}
