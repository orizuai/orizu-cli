const SCORE_FORMATS = new Set(['percent', 'number', 'integer', 'currency'])

export function formatScoreForCli(score: unknown, scoreFormat: unknown): string {
  if (typeof scoreFormat !== 'string' || !SCORE_FORMATS.has(scoreFormat)) {
    return String(score ?? '—')
  }
  if (score === null || score === undefined || (typeof score === 'number' && Number.isNaN(score))) {
    return 'Not scored'
  }
  if (typeof score !== 'number') return String(score)

  if (scoreFormat === 'number') return score.toFixed(3).replace(/\.?0+$/u, '')
  if (scoreFormat === 'integer') return Math.round(score).toLocaleString()
  if (scoreFormat === 'currency') return `$${score.toFixed(2)}`
  return `${(score * 100).toFixed(1)}%`
}
