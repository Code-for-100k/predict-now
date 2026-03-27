/**
 * Structured audit logger for admin and financial operations.
 * Outputs JSON with { audit: true } prefix so it can be filtered in Railway logs.
 */

export interface AuditEvent {
  event: string;
  timestamp: string;
  actor: string; // uid, IP, or "system"
  details: Record<string, any>;
}

export function auditLog(event: AuditEvent): void {
  console.log(JSON.stringify({ audit: true, ...event }));
}
