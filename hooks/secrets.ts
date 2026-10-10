export type MaskResult = { text: string; count: number; kinds: string[] }

type Pattern = { kind: string; re: RegExp; group?: number }

const PATTERNS: Pattern[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws-secret',
    re: /(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)(\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/g,
    group: 3,
  },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'url-password',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]{3,})(@)/gi,
    group: 2,
  },
  {
    kind: 'credential',
    re: /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*["']?)(\s*[:=]\s*["']?)([A-Za-z0-9_\-/+=.]{12,})/gi,
    group: 3,
  },
]

const MARK = '[REDACTED:'

function looksSecret(value: string): boolean {
  if (value.includes(MARK) || value.includes('…')) return false
  if (/^(process\.env|os\.environ|env\.|\$\{|<|your[_-]|xxx|example|changeme|placeholder)/i.test(value)) {
    return false
  }

  return /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

function groupCount(re: RegExp): number {
  return (new RegExp(`${re.source}|`).exec('')?.length ?? 1) - 1
}

function masked(value: string, kind: string): string {
  return `${value.slice(0, 4)}…${MARK}${kind}]`
}

/** Masks every credential-shaped value in `text`, keeping its first four characters. */
export function maskSecrets(text: string): MaskResult {
  let out = text
  let count = 0
  const kinds = new Set<string>()
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    out = out.replace(pattern.re, (...match: unknown[]) => {
      const whole = String(match[0])
      const group = pattern.group
      if (group === undefined) {
        if (whole.includes(MARK)) return whole
        count += 1
        kinds.add(pattern.kind)

        return masked(whole, pattern.kind)
      }
      const value = String(match[group] ?? '')
      if (pattern.kind === 'credential' && !looksSecret(value)) return whole
      if (value.includes(MARK)) return whole
      count += 1
      kinds.add(pattern.kind)
      const parts = match.slice(1, 1 + groupCount(pattern.re)).map(one => String(one ?? ''))
      const before = parts.slice(0, group - 1).join('')
      const after = parts.slice(group).join('')

      return `${before}${masked(value, pattern.kind)}${after}`
    })
  }

  return { text: out, count, kinds: [...kinds] }
}
