export const connectedNavigation = [
  ['/', '◫', '금융 현황'], ['/transactions', '≡', '거래'], ['/budgets', '◔', '월별 예산'],
  ['/recurring-payments', '↻', '정기 결제'], ['/account-balances', '▣', '계좌 잔액'], ['/investments', '↗', '투자·외화'], ['/card-installments', '↗', '카드 할부 계획'],
  ['/card-benefits', '◇', '카드 혜택'], ['/ledger-summary', '▤', '확정 원장'],
] as const

export const demoNavigation = [
  ['/demo', '◫', '금융 현황'], ['/transactions?mode=demo', '≡', '거래'],
  ['/demo/budgets', '◔', '예산'], ['/recurring-payments', '↻', '정기 결제'], ['/demo/accounts', '▣', '계좌·카드'],
  ['/investments?mode=demo', '↗', '투자·외화'], ['/ledger-summary', '▤', '결산·보고서'],
] as const
