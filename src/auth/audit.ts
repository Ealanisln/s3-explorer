// JSON-lines audit log to stdout. Picked up by Loki/Promtail or whatever ships
// from the container. Never include passwords, TOTP secrets, or session jtis
// of OTHER users — those are exfiltration risks.
export function audit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
