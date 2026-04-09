/**
 * Structured audit logger for admin and financial operations.
 * Outputs JSON with { audit: true } prefix so it can be filtered in Railway logs.
 * Also writes to the audit_log Postgres table when DATABASE_URL is set.
 */

export interface AuditEvent {
  event: string;
  timestamp: string;
  actor: string; // uid, IP, or "system"
  details: Record<string, any>;
}

export function auditLog(event: AuditEvent): void {
  // Always log to console (works with JSON file backend too)
  console.log(JSON.stringify({ audit: true, ...event }));

  // Write to Postgres audit_log table if available (fire-and-forget — audit should not block)
  if (process.env.DATABASE_URL) {
    import("../db/postgres.js").then(({ pgQuery }) => {
      pgQuery(
        `INSERT INTO audit_log (event, actor, details, timestamp) VALUES ($1, $2, $3, $4)`,
        [event.event, event.actor, JSON.stringify(event.details), event.timestamp]
      ).catch((err) => {
        console.error("[Audit] Failed to write to Postgres:", (err as Error).message);
      });
    }).catch((err) => {
      console.error("[Audit] Failed to load Postgres module:", (err as Error).message);
    });
  }
}
