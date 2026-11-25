const won = new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' })
const dateTime = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
})

export function formatWon(value: string) {
  return won.format(BigInt(value))
}

export function formatSeoulTime(value: string) {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? dateTime.format(milliseconds) : '시각 확인 필요'
}
