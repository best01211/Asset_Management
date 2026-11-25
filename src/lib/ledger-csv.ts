const transactionColumns = [
  'transaction_id', 'kind', 'description', 'amount_minor', 'currency', 'occurred_at_utc',
  'source_pending_id', 'original_purchase_id', 'transfer_id', 'balance_check_id',
]
const entryColumns = [
  'entry_id', 'transaction_id', 'kind', 'account_id', 'account_name', 'side',
  'amount_minor', 'currency', 'occurred_at_utc',
]

export type LedgerExportKind = 'transactions' | 'entries'

function cell(value: string | null) {
  const source = value ?? ''
  const safe = /^[\s\uFEFF]*[=+\-@＝＋－＠]|^[\r\n\t]/u.test(source) ? "'" + source : source
  return '"' + safe.replaceAll('"', '""') + '"'
}

export function ledgerCsv(kind: LedgerExportKind, rows: (string | null)[][]) {
  const columns = kind === 'transactions' ? transactionColumns : entryColumns
  return financeCsv([columns, ...rows])
}

export function financeCsv(rows: (string | null)[][]) {
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
