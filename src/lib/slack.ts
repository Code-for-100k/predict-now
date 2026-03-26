/**
 * Slack webhook helper for circuit breaker alerts.
 */

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

export async function sendSlackAlert(text: string, blocks?: any[]): Promise<boolean> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("[Slack] No SLACK_WEBHOOK_URL configured — skipping alert");
    return false;
  }

  try {
    const body: any = { text };
    if (blocks) body.blocks = blocks;

    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[Slack] Webhook failed (${res.status}): ${await res.text()}`);
      return false;
    }

    console.log("[Slack] Alert sent successfully");
    return true;
  } catch (err) {
    console.error("[Slack] Webhook error:", err instanceof Error ? err.message : err);
    return false;
  }
}

export function formatCircuitBreakerAlert(data: {
  tripped: boolean;
  avgReward: number;
  avgGas: number;
  netMargin: number;
  threshold: number;
  reason: string;
}): { text: string; blocks: any[] } {
  const emoji = data.tripped ? ":rotating_light:" : ":white_check_mark:";
  const status = data.tripped ? "TRIPPED" : "RECOVERED";
  const color = data.tripped ? "#ef4444" : "#22c55e";

  const text = `${emoji} Circuit Breaker ${status} — net margin ${data.netMargin.toFixed(4)} CC/txn (threshold: ${data.threshold} CC)`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} Circuit Breaker ${status}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Avg Reward/Txn:*\n${data.avgReward.toFixed(4)} CC` },
        { type: "mrkdwn", text: `*Avg Gas/Txn:*\n${data.avgGas.toFixed(4)} CC` },
        { type: "mrkdwn", text: `*Net Margin:*\n${data.netMargin.toFixed(4)} CC` },
        { type: "mrkdwn", text: `*Threshold:*\n${data.threshold} CC` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: data.tripped
        ? `:no_entry: *Actions taken:* Agents paused, auto-payouts switched to internal ledger only.\n_Reason: ${data.reason}_`
        : `:arrow_forward: *Actions taken:* Agents resumed, auto-payouts re-enabled.`
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Predict Now • ${new Date().toISOString()}` }],
    },
  ];

  return { text, blocks };
}
