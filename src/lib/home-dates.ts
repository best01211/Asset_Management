const dayMs = 86_400_000
const utcDate = (date: string) => new Date(date + 'T00:00:00Z')
const isoDate = (date: Date) => date.toISOString().slice(0, 10)

export function daysBetween(first: string, second: string) {
  return (utcDate(second).getTime() - utcDate(first).getTime()) / dayMs
}

export function monthEnd(date: string, offset = 0) {
  const [year, month] = date.split('-').map(Number)
  return isoDate(new Date(Date.UTC(year, month + offset, 0)))
}

export function monthsBefore(date: string, offset: number) {
  const first = utcDate(date.slice(0, 7) + '-01')
  first.setUTCMonth(first.getUTCMonth() - offset)
  const last = monthEnd(isoDate(first))
  first.setUTCDate(Math.min(Number(date.slice(8)), Number(last.slice(8))))
  return isoDate(first)
}
