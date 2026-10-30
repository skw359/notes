import pg from 'pg';

// int8 (revisions, sync sequence numbers, counts) as numbers rather than
// strings; values beyond 2^53 never occur in practice but stay strings.
pg.types.setTypeParser(20, (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
});

// Advisory-lock namespaces (first key of pg_advisory_*lock(int, int)).
export const LOCK_NAMESPACE = {
  // Serializes every write to one user's notes so sync sequence numbers
  // commit in order and multi-row operations cannot deadlock with saves.
  userNotes: 7301,
  migrations: 7302,
  maintenance: 7303,
};

export function createPool(dbConfig) {
  const pool = new pg.Pool(
    dbConfig.connectionString
      ? { connectionString: dbConfig.connectionString, max: dbConfig.maxConnections }
      : {
          user: dbConfig.user,
          host: dbConfig.host,
          database: dbConfig.database,
          password: dbConfig.password,
          port: dbConfig.port,
          max: dbConfig.maxConnections,
        }
  );

  // An idle client losing its connection (e.g. a database restart) must not
  // crash the process; the pool replaces it on the next checkout.
  pool.on('error', (error) => {
    console.error('Idle database client error:', error.message);
  });

  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the original error is the useful one
    }
    throw error;
  } finally {
    client.release();
  }
}

// Must be the first lock a note-writing transaction takes (see LOCK_NAMESPACE).
export async function lockUserNotes(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE.userNotes, userId]);
}

export async function lockUserNotesShared(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [LOCK_NAMESPACE.userNotes, userId]);
}
