/**
 * Best-effort secret redaction utility.
 *
 * Limitations:
 * - Scans strings for known sensitive literals and replaces matches with '[REDACTED]'.
 * - Best-effort defense-in-depth only: cannot detect base64-encoded, URL-encoded,
 *   or fragmented secrets split across stream chunks.
 * - True isolation is guaranteed by container sandbox configuration (never injecting
 *   infrastructure secrets into build container environments).
 */
export function redactSecrets(text: string, secretsToRedact: (string | undefined)[] = []): string {
  if (!text) return '';
  let sanitized = text;

  for (const secret of secretsToRedact) {
    if (secret && typeof secret === 'string' && secret.trim().length >= 4) {
      sanitized = sanitized.replaceAll(secret, '[REDACTED]');
    }
  }

  return sanitized;
}
