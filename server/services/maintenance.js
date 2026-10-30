import { LOCK_NAMESPACE, lockUserNotes, withTransaction } from '../db.js';
import { sweepLegacyQuarantine } from '../lib/legacyUploads.js';
import { collectGarbageBlobs } from './blobs.js';

function seconds(ms) {
  return Math.floor(ms / 1000);
}

// Trash expiry runs on a schedule instead of inside GET /trash (PERF-1,
// DATA-9). Per user, under that user's note lock; tombstones are written by
// the delete trigger so other devices learn about the deletion.
async function purgeExpiredTrash(pool, config) {
  const users = await pool.query(
    `SELECT DISTINCT user_id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(secs => $1)`,
    [seconds(config.retention.trashMs)]
  );
  let purged = 0;
  for (const { user_id: userId } of users.rows) {
    purged += await withTransaction(pool, async (db) => {
      await lockUserNotes(db, userId);
      const result = await db.query(
        `DELETE FROM notes WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(secs => $2)`,
        [userId, seconds(config.retention.trashMs)]
      );
      return result.rowCount;
    });
  }
  return purged;
}

// Rows created by POST /api/notes whose first save never arrived (the
// interrupted two-step create). Rows holding a stored conflict are kept.
async function removeAbandonedPendingNotes(pool, config) {
  const users = await pool.query(
    `
      SELECT DISTINCT n.user_id FROM notes n
      WHERE n.revision = 0 AND n.created_at < NOW() - make_interval(secs => $1)
    `,
    [seconds(config.retention.pendingNoteMs)]
  );
  let removed = 0;
  for (const { user_id: userId } of users.rows) {
    removed += await withTransaction(pool, async (db) => {
      await lockUserNotes(db, userId);
      const result = await db.query(
        `
          DELETE FROM notes n
          WHERE n.user_id = $1 AND n.revision = 0
            AND n.encrypted_content IS NULL AND n.content IS NULL AND n.encrypted_summary IS NULL
            AND n.created_at < NOW() - make_interval(secs => $2)
            AND NOT EXISTS (SELECT 1 FROM note_revisions r WHERE r.note_id = n.id)
        `,
        [userId, seconds(config.retention.pendingNoteMs)]
      );
      return result.rowCount;
    });
  }
  return removed;
}

// Snapshots and resolved conflicts expire; unresolved conflicts never do.
async function pruneOldRevisions(pool, config) {
  const result = await pool.query(
    `
      DELETE FROM note_revisions
      WHERE (kind = 'snapshot' OR resolved_at IS NOT NULL)
        AND created_at < NOW() - make_interval(secs => $1)
    `,
    [seconds(config.retention.revisionMaxAgeMs)]
  );
  return result.rowCount;
}

async function removeExpiredSessions(pool, config) {
  const result = await pool.query(
    `
      DELETE FROM sessions
      WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - make_interval(secs => $1))
         OR expires_at < NOW() - make_interval(secs => $1)
    `,
    [seconds(config.retention.sessionsMs)]
  );
  return result.rowCount;
}

// Abandoned legacy migrations (ciphertext only) do not linger forever.
async function removeStaleMigrationStaging(pool) {
  const result = await pool.query(`DELETE FROM migration_staging WHERE staged_at < NOW() - INTERVAL '30 days'`);
  return result.rowCount;
}

/**
 * Runs every maintenance task once. A session-level advisory lock makes
 * concurrent runs (several instances, or the CLI next to the server) skip
 * instead of overlapping. Each task is isolated: one failing does not stop
 * the others.
 */
export async function runMaintenance({ pool, storage, config, log = console }) {
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock($1, 0) AS acquired', [LOCK_NAMESPACE.maintenance]);
    if (!lock.rows[0].acquired) {
      return { skipped: true };
    }

    const tasks = {
      purgedTrash: () => purgeExpiredTrash(pool, config),
      removedPendingNotes: () => removeAbandonedPendingNotes(pool, config),
      prunedRevisions: () => pruneOldRevisions(pool, config),
      blobGc: () => collectGarbageBlobs({ pool, storage, config, log }),
      sweptDeletedFiles: () => storage.sweepDeleted(config.retention.deletedFilesMs),
      sweptLegacyQuarantine: () =>
        sweepLegacyQuarantine(config.storage.legacyQuarantineDir, config.retention.legacyQuarantineMs),
      removedTempUploads: () => storage.cleanupTemp(24 * 60 * 60 * 1000),
      removedSessions: () => removeExpiredSessions(pool, config),
      removedMigrationStaging: () => removeStaleMigrationStaging(pool),
    };

    const results = {};
    for (const [name, task] of Object.entries(tasks)) {
      try {
        results[name] = await task();
      } catch (error) {
        results[name] = { error: error.message };
        log.error?.(`[maintenance] ${name} failed:`, error);
      }
    }
    return results;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1, 0)', [LOCK_NAMESPACE.maintenance]).catch(() => {});
    lockClient.release();
  }
}

export function startMaintenanceSchedule(ctx, { initialDelayMs = 60 * 1000 } = {}) {
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) {
      return;
    }
    try {
      const results = await runMaintenance(ctx);
      if (!results.skipped) {
        ctx.log?.info?.('[maintenance]', JSON.stringify(results));
      }
    } catch (error) {
      ctx.log?.error?.('[maintenance] run failed:', error);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, ctx.config.jobs.intervalMs);
        timer.unref?.();
      }
    }
  }

  timer = setTimeout(tick, initialDelayMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
