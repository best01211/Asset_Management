import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import PDFDocument from 'pdfkit'
import { financeJson, financeRpcError, requireFinanceUser } from '@/lib/finance-api'
import { financeCsv } from '@/lib/ledger-csv'
import { isBudgetMonth } from '@/lib/monthly-budget'
import { reportXlsx } from '@/lib/report-xlsx'

export const runtime = 'nodejs'

type Snapshot = {
  ledger: { spending_minor: string; gross_spending_minor: string; refund_minor: string; fee_minor: string;
    categories: { name: string; amount_minor: string }[] }
  budget: { total: { amount_minor: string | null } | null;
    categories: { name: string; amount_minor: string | null; spent_minor: string }[] }
  accounts: { name: string; kind: 'asset' | 'liability'; balance_minor: string | null }[]
  known_net_assets_minor: string | null
  unknown_balance_count: number
}

type Statement = { card: string; billed_minor: string; benefit_minor: string | null; paid_minor: string; remaining_minor: string }
type DataRow = [string, string, string]

function reportRows(snapshot: Snapshot, statements: Statement[], version: number | null) {
  const rows: DataRow[] = [
    ['기준', version === null ? '현재 원장' : '저장 결산 버전', version === null ? '' : String(version)],
    ['지출', '확정 순지출', snapshot.ledger.spending_minor],
    ['지출', '구매액', snapshot.ledger.gross_spending_minor],
    ['지출', '환불', snapshot.ledger.refund_minor],
    ['지출', '이체 수수료', snapshot.ledger.fee_minor],
    ['예산', '전체 예산', snapshot.budget.total?.amount_minor ?? '미설정'],
    ['잔액', '확인 가능한 원화 순자산', snapshot.known_net_assets_minor ?? '미확인'],
    ['잔액', '미확인 계좌 수', String(snapshot.unknown_balance_count)],
  ]
  for (const category of snapshot.ledger.categories) rows.push(['카테고리 지출', category.name, category.amount_minor])
  for (const category of snapshot.budget.categories) {
    rows.push(['카테고리 예산', category.name, category.amount_minor ?? '미설정'])
  }
  for (const account of snapshot.accounts) rows.push([
    account.kind === 'asset' ? '자산 잔액' : '부채 잔액', account.name, account.balance_minor ?? '미확인',
  ])
  for (const item of statements) {
    rows.push(['현재 카드 명세서', item.card + ' 청구', item.billed_minor],
      ['현재 카드 명세서', item.card + ' 납부', item.paid_minor],
      ['현재 카드 명세서', item.card + ' 미납', item.remaining_minor],
      ['현재 카드 명세서', item.card + ' 실제 혜택', item.benefit_minor ?? '미확인'])
  }
  return rows
}

async function pdf(month: string, rows: DataRow[]) {
  const fontFile = join(process.cwd(), 'node_modules', '@expo-google-fonts', 'noto-sans-kr', '400Regular', 'NotoSansKR_400Regular.ttf')
  const font = await readFile(fontFile)
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, right: 48, bottom: 48, left: 48 } })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.font(font).fontSize(19).text(month + ' 월간 금융 보고서')
    doc.moveDown().fontSize(10).text('금액 단위 원 · 카드 명세서는 조회 시점 기준').moveDown()
    for (const [section, item, value] of rows) doc.text(section + ' / ' + item + '  ' + value, { lineGap: 4 })
    doc.end()
  })
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const month = params.get('month')
  const format = params.get('format') ?? 'csv'
  const rawVersion = params.get('version')
  if (!isBudgetMonth(month) || !['csv', 'xlsx', 'pdf'].includes(format)
    || (rawVersion !== null && (!/^[1-9]\d{0,9}$/.test(rawVersion) || Number(rawVersion) > 2147483647))) {
    return financeJson({ error: 'INVALID_INPUT' }, 400)
  }
  const { supabase, response } = await requireFinanceUser()
  if (!supabase) return response
  const version = rawVersion === null ? null : Number(rawVersion)
  const results = await Promise.all([
    supabase.rpc('get_monthly_financial_closing', { p_month: month + '-01', p_version: version }),
    supabase.rpc('list_card_statements', { p_month: month + '-01' }),
  ])
  if (results[0].error) return financeRpcError(results[0].error, 'REPORT_READ_FAILED')
  if (results[1].error) return financeRpcError(results[1].error, 'REPORT_READ_FAILED')
  const snapshot: Snapshot = version === null ? results[0].data.current : results[0].data.saved.snapshot
  const rows = reportRows(snapshot, results[1].data, version)
  try {
    let body: string | Uint8Array<ArrayBuffer>
    let contentType: string
    if (format === 'csv') {
      body = financeCsv([['구분', '항목', '금액 (원) 또는 값'], ...rows])
      contentType = 'text/csv; charset=utf-8'
    } else {
      body = Uint8Array.from(format === 'pdf' ? await pdf(month, rows) : reportXlsx([['구분', '항목', '금액 (원) 또는 값'], ...rows]))
      contentType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    return new Response(body, { headers: {
      'Content-Type': contentType, 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'attachment; filename="finance-' + month + '.' + format + '"',
    } })
  } catch {
    return financeJson({ error: 'REPORT_GENERATION_FAILED' }, 500)
  }
}
