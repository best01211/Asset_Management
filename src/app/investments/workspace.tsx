'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  dec,
  decimal,
  holdings,
  keyOf,
  money,
  mul,
  replay,
  scale,
  sumKnown,
  type Book,
  type Entry,
  type Holding,
} from '@/lib/investment-book'
import { EntryForm, localDate } from './entry-form'
import { ValuationTrend } from './valuation-trend'
import {
  Analysis,
  History,
  Metrics,
  PriceHistory,
  classifications,
  fxEffect,
  insightLines,
  pct,
} from './analytics'
import { demoKey, mergePrices, refreshPrices, readBook, saveChange, type Change } from './portfolio-data'

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog className="iv-dialog" ref={ref} onCancel={close}>
      <header>
        <h2>{title}</h2>
        <button className="outline" onClick={close} aria-label="닫기">
          ×
        </button>
      </header>
      {children}
    </dialog>
  )
}
function details(r: Holding, book: Book, showQuoteBasis: boolean): [string, string][] {
  const fx = !r.symbol,
    jpy = r.currency === 'JPY' ? 100n : 1n
  const metrics: [string, string][] = [
    ['미실현 ' + (fx ? '환차손익' : '평가손익'), money(r.gain)],
    ['수익률', pct(r.percent)],
    ['보유 수량', decimal(r.qty) + (fx ? ' ' + r.currency : '주')],
    ['취득 원가', r.cost === null ? '원가 미등록' : money(r.cost)],
    ...((fx
      ? []
      : [
          ['거래소', r.exchange || '미등록'],
          ['평균 매입가', r.average === null ? '—' : money(r.average, r.currency)],
          ['현재가', money(r.price, r.currency)],
          [
            '현지 통화 평가손익',
            r.price === null ? '산정 보류' : money(mul(r.qty, r.price) - r.local, r.currency),
          ],
          [
            '현지 가격 기준',
            r.priceQuote
              ? new Date(r.priceQuote.at).toLocaleString('ko-KR') + ' · ' + r.priceQuote.source
              : '시세 미등록',
          ],
        ]) as [string, string][]),
    ...((r.currency === 'KRW'
      ? []
      : [
          ...(fx
            ? [
                [
                  '평균 취득 환율',
                  r.average === null
                    ? '원가 미등록'
                    : decimal(r.average * jpy) + '원 / ' + jpy + ' ' + r.currency,
                ],
              ]
            : []),
          [
            '기준 환율',
            r.rate === null ? '환율 미등록' : decimal(r.rate * jpy) + '원 / ' + jpy + ' ' + r.currency,
          ],
          [
            '환율 기준',
            r.rateQuote
              ? new Date(r.rateQuote.at).toLocaleString('ko-KR') + ' · ' + r.rateQuote.source
              : '미등록',
          ],
        ]) as [string, string][]),
    ...r.accounts.map(
      (a) =>
        [
          book.accounts.find((x) => x.id === a.account)?.name || '계좌',
          decimal(a.units) + (fx ? ' ' + r.currency : '주'),
        ] as [string, string],
    ),
  ]
  return showQuoteBasis
    ? metrics
    : metrics.filter(([label]) => label !== '현지 가격 기준' && label !== '환율 기준')
}
type Dialog = 'entry' | 'quote' | 'account' | 'cancel' | 'detail' | null
export default function Portfolio({ demo, view, asset }: { demo: boolean; view: string; asset: string }) {
  const params = useSearchParams(),
    fx = params.get('tab') === 'fx',
    analysis = params.get('panel') === 'analysis'
  const quoteHistory = view === 'asset' ? asset : view === 'home' ? 'analysis' : ''
  const [book, setBook] = useState<Book | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null),
    [edit, setEdit] = useState<Entry>(),
    [filter, setFilter] = useState('all'),
    [query, setQuery] = useState(''),
    [sort, setSort] = useState('value')
  const [refreshing, setRefreshing] = useState(false),
    [saving, setSaving] = useState(false)
  const retry = useRef<{ payload: string; request: string } | null>(null)
  const inFlight = useRef(false)
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    try {
      const result = await refreshPrices(demo)
      setNotice(result.message)
      setBook((current) =>
        current ? { ...current, quotes: mergePrices(current.quotes, result.quotes) } : current,
      )
    } catch {
      setNotice('외부 시세를 조회하지 못했습니다. 마지막 저장값을 표시합니다.')
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [demo])
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    poll()
    const timer = window.setInterval(poll, 60000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [refresh])
  useEffect(() => {
    let live = true
    const read = () =>
      readBook(demo, quoteHistory)
        .then((b) => {
          if (live) {
            setBook(b)
            setError('')
          }
          return b
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
    void read()
    const sync = (e: StorageEvent) => {
      if (demo && e.key === demoKey) void read()
    }
    window.addEventListener('storage', sync)
    return () => {
      live = false
      window.removeEventListener('storage', sync)
    }
  }, [demo, quoteHistory])
  const data = useMemo(() => {
    if (!book) return null
    const p = replay(book)
    return { ...p, shares: holdings(p.stocks, book.quotes), currencies: holdings(p.cash, book.quotes) }
  }, [book])
  const rows = fx ? data?.currencies : data?.shares
  const visible = useMemo(
    () =>
      (rows || [])
        .filter(
          (r) =>
            (fx || filter === 'all' || r.category === filter) &&
            (r.name + ' ' + r.symbol + ' ' + r.currency).toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => {
          if (sort === 'name') return a.name.localeCompare(b.name, 'ko')
          const field = sort === 'gain' ? 'gain' : sort === 'percent' ? 'percent' : 'value',
            l = a[field],
            r = b[field]
          return l === r ? 0 : l === null ? 1 : r === null ? -1 : l > r ? -1 : 1
        }),
    [rows, fx, filter, query, sort],
  )
  const row =
    view === 'asset'
      ? rows?.find((r) => r.id === asset)
      : visible.find((r) => r.id === params.get('selected')) || visible[0]
  function url(path = '', changes: Record<string, string> = {}) {
    const p = new URLSearchParams(params.toString())
    if (demo) p.set('mode', 'demo')
    for (const [k, v] of Object.entries(changes)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    return '/investments' + path + (p.size ? '?' + p : '')
  }
  function select(changes: Record<string, string>) {
    window.history.replaceState(null, '', url('', changes))
  }
  const close = () => {
    setDialog(null)
    setEdit(undefined)
    setError('')
  }
  async function save(change: Change) {
    if (change.action === 'event') {
      const payload = JSON.stringify([change.entry, change.create])
      if (retry.current?.payload === payload) change = { ...change, request: retry.current.request }
      else retry.current = { payload, request: change.request }
    }
    setBook(await saveChange(demo, change, quoteHistory))
    retry.current = null
    setNotice('저장했습니다.')
  }
  function openEntry(e?: Entry) {
    setEdit(e)
    setDialog(book?.accounts.length ? 'entry' : 'account')
  }
  const manage = (e: Entry) => {
    setEdit(e)
    setDialog('cancel')
  }
  const historyProps = { onEdit: openEntry, onCancel: manage }
  const quoteButton = (
    <button className="outline" onClick={() => setDialog('quote')}>
      시세·환율 입력
    </button>
  )
  if (!book || !data || !rows)
    return (
      <>
        <h1>투자·외화</h1>
        <p role="status">{error || '투자 원장을 불러오는 중입니다.'}</p>
        {error && <Link href="/investments?mode=demo">샘플 열기</Link>}
      </>
    )
  const stocks = sumKnown(data.shares.map((r) => r.value)),
    cash = sumKnown(data.currencies.map((r) => r.value)),
    all = [...data.shares, ...data.currencies],
    gain = sumKnown(all.map((r) => r.gain)),
    basis = sumKnown(all.map((r) => r.cost))
  const timestamp = book.quotes.reduce((max, q) => Math.max(Date.parse(q.at), max), 0)
  const sources = [
    ...new Set(
      [...data.shares, ...data.currencies]
        .flatMap((r) => [r.priceQuote, r.rateQuote])
        .flatMap((q) => (q ? [q.source] : [])),
    ),
  ]
  const prefill = edit || {
    kind: fx ? ('deposit' as const) : ('buy' as const),
    symbol: row?.symbol || '',
    name: row?.name || '',
    currency: row?.currency || (fx ? 'USD' : 'KRW'),
    exchange: row?.exchange || '',
    category: row?.category || 'unknown',
    rate: row?.currency === 'KRW' ? '1' : '',
    account: row?.accounts[0]?.account || book.accounts[0]?.id,
  }
  const assistant = () =>
    window.dispatchEvent(
      new CustomEvent('finance-assistant:open', {
        detail:
          (row?.name || '전체 자산') +
          '의 ' +
          (fx ? '환차손익과 통화 비중' : '평가손익과 투자 비중') +
          '을 설명해 주세요. 조회 기간은 ' +
          (params.get('period') || '보유 기간 전체') +
          '입니다.',
      }),
    )
  const detailPanel = row && (
    <>
      <small>
        {row.symbol ? row.symbol + ' · ' + (classifications[row.category] || '미분류') : row.currency}
      </small>
      <h2>{row.name}</h2>
      <strong className="iv-valuation">{money(row.value)}</strong>
      <Metrics rows={details(row, book, view === 'asset' || !row.symbol)} />
      <div className="iv-tools">
        <button onClick={() => openEntry()}>거래 등록</button>
        {view === 'asset' && quoteButton}
        {view !== 'asset' && (
          <Link
            className="button outline"
            href={
              row.symbol
                ? url('/asset/' + encodeURIComponent(row.id), { selected: row.id })
                : url('/history', { currency: row.currency })
            }
          >
            {row.symbol ? '종목 상세 분석' : '환전·입출금 내역'}
          </Link>
        )}
      </div>
    </>
  )
  return (
    <div className="iv-page">
      <header className="iv-header">
        <div>
          <h1>
            {view === 'home'
              ? '투자·외화'
              : view === 'history'
                ? '전체 거래 관리'
                : row?.name || '종목 상세 분석'}
          </h1>
          <small>
            {demo ? '브라우저 샘플' : '투자 원장'} ·{' '}
            {timestamp ? '최근 시세 ' + new Date(timestamp).toLocaleString('ko-KR') : '시세 미등록'}
            {sources.length ? ' · ' + sources.join(', ') : ''} · 1분마다 조회 · 시장별 지연 가능
          </small>
        </div>
        <div className="iv-tools">
          {view !== 'home' && <Link href={url('', { currency: '' })}>보유 현황으로</Link>}
          <button className="outline" disabled={refreshing} onClick={refresh}>
            {refreshing ? '조회 중' : '새로고침'}
          </button>
        </div>
      </header>
      {notice && (
        <p role="status" className="iv-notice">
          {notice}
        </p>
      )}
      {view === 'home' ? (
        <>
          <section className="iv-summary">
            <div>
              <span>총 투자·외화 평가액</span>
              <strong>{money(sumKnown([stocks, cash]))}</strong>
            </div>
            <div>
              <span>미실현 평가손익</span>
              <b className={gain === null ? '' : gain > 0n ? 'pos' : gain < 0n ? 'neg' : ''}>{money(gain)}</b>
              <small>
                원가 대비{' '}
                {pct(gain !== null && basis !== null && basis > 0n ? (gain * 100n * scale) / basis : null)}
              </small>
            </div>
            <div>
              <span>투자 자산</span>
              <b>{money(stocks)}</b>
              <span>외화 현금</span>
              <b>{money(cash)}</b>
            </div>
            <div>
              <span>실현 매매손익</span>
              <b>{money(data.realized)}</b>
              <span>실현 환차손익</span>
              <b>{money(data.fxGain)}</b>
            </div>
          </section>
          <ValuationTrend book={book} total={sumKnown([stocks, cash])} />
          <nav className="iv-tabs" aria-label="자산 유형">
            {['투자 자산', '외화 자산'].map((s, i) => (
              <button
                key={s}
                aria-pressed={fx === !!i}
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                  select({ tab: i ? 'fx' : 'stock', selected: '' })
                }}
              >
                {s}
              </button>
            ))}
          </nav>
          <div className="iv-toolbar">
            <div className="iv-segments">
              {['보유 현황', '자산 분석'].map((s, i) => (
                <button
                  key={s}
                  aria-pressed={analysis === !!i}
                  onClick={() => select({ panel: i ? 'analysis' : 'holdings' })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="iv-tools">
              <button onClick={() => openEntry()}>거래 등록</button>
              {quoteButton}
              <Link className="button outline" href={url('/history')}>
                전체 거래 관리
              </Link>
            </div>
          </div>
          {analysis ? (
            <Analysis
              rows={rows}
              fx={fx}
              realized={fx ? data.fxGain : data.realized}
              dividends={data.dividends}
              fees={data.charges}
              events={book.events}
              quotes={book.quotes}
            />
          ) : (
            <div className="iv-grid">
              <section className="iv-panel">
                <div className="iv-panel-title">
                  <h2>
                    {fx ? '보유 통화' : '보유 종목'} <small>{rows.length}</small>
                  </h2>
                  <button className="outline" onClick={() => setDialog('account')}>
                    계좌 추가
                  </button>
                </div>
                <div className="iv-tools iv-filters">
                  <input
                    aria-label="보유 자산 검색"
                    placeholder={fx ? '통화 검색' : '종목명 · 티커 검색'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {!fx && (
                    <select aria-label="종목 구분" value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <option value="all">전체 종목</option>
                      {Object.entries(classifications).map(([v, n]) => (
                        <option value={v} key={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  )}
                  <select aria-label="정렬" value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="value">평가액순</option>
                    <option value="gain">손익순</option>
                    <option value="percent">수익률순</option>
                    <option value="name">이름순</option>
                  </select>
                </div>
                <table className="iv-holdings">
                  <thead>
                    <tr>
                      <th>{fx ? '통화' : '종목'}</th>
                      <th>수량</th>
                      <th className="iv-prices">{fx ? '평균 / 기준 환율' : '평균 매입가 / 현재가'}</th>
                      <th>평가액</th>
                      <th>손익 / 수익률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr
                        key={r.id}
                        className={row?.id === r.id ? 'selected' : ''}
                        onClick={() => {
                          select({ selected: r.id })
                          if (window.matchMedia('(max-width:760px)').matches) setDialog('detail')
                        }}
                      >
                        <td>
                          <button>{r.name}</button>
                          <small>
                            {r.symbol
                              ? r.symbol + ' · ' + (classifications[r.category] || '미분류')
                              : currencyName(r.currency)}
                          </small>
                          {r.symbol && (
                            <small className="iv-brokers">
                              {r.accounts
                                .map((a) => book.accounts.find((b) => b.id === a.account)?.name)
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          )}
                        </td>
                        <td>{decimal(r.qty)}</td>
                        <td className="iv-prices">
                          {fx
                            ? r.average === null
                              ? '원가 미등록'
                              : money(r.average * (r.currency === 'JPY' ? 100n : 1n))
                            : money(r.average, r.currency)}
                          <small>
                            {fx
                              ? r.rate === null
                                ? '환율 미등록'
                                : money(r.rate * (r.currency === 'JPY' ? 100n : 1n)) +
                                  (r.currency === 'JPY' ? ' / 100 JPY' : ' / 1 ' + r.currency)
                              : money(r.price, r.currency)}
                          </small>
                        </td>
                        <td>
                          <b>{money(r.value)}</b>
                        </td>
                        <td className={r.gain === null ? '' : r.gain > 0n ? 'pos' : r.gain < 0n ? 'neg' : ''}>
                          {money(r.gain)}
                          <small>{pct(r.percent)}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length && <p>표시할 보유 자산이 없습니다.</p>}
              </section>
              <aside className="iv-panel iv-detail">{detailPanel || <p>보유 자산을 선택하세요.</p>}</aside>
            </div>
          )}
          <section className="iv-insight">
            <div>
              <h2>{fx ? '외화' : '투자'} 핵심 인사이트</h2>
              {insightLines(rows, fx).map((s) => (
                <p key={s}>{s}</p>
              ))}
            </div>
            <button className="outline" onClick={assistant}>
              AI에게 자세히 질문하기
            </button>
          </section>
        </>
      ) : view === 'history' ? (
        <>
          <div className="iv-tools">
            <button onClick={() => openEntry()}>거래 등록</button>
            {quoteButton}
            <button className="outline" onClick={() => setDialog('account')}>
              계좌 추가
            </button>
          </div>
          <History
            book={book}
            events={book.events.filter(
              (e) => !params.get('currency') || [e.currency, e.target].includes(params.get('currency')!),
            )}
            {...historyProps}
          />
        </>
      ) : row ? (
        <>
          <div className="iv-grid">
            <section className="iv-panel">
              {detailPanel}
              <Metrics
                rows={[
                  ['실현 매매손익', money(data.bySecurity.get(row.id)?.realized ?? 0n)],
                  ['순배당금', money(data.bySecurity.get(row.id)?.dividends ?? 0n)],
                  ['거래 수수료', money(data.bySecurity.get(row.id)?.fees ?? 0n)],
                  ['세금', money(data.bySecurity.get(row.id)?.tax ?? 0n)],
                  ['원화 평가손익 중 취득 환율 영향', money(fxEffect(row))],
                ]}
              />
            </section>
            <PriceHistory book={book} row={row} />
          </div>
          <History
            book={book}
            events={book.events.filter((e) => e.symbol === row.symbol && e.currency === row.currency)}
            {...historyProps}
          />
        </>
      ) : (
        <p>현재 보유 중인 종목이 없습니다.</p>
      )}
      {dialog && (
        <Modal
          title={
            dialog === 'entry'
              ? edit
                ? '거래 정정'
                : '거래 등록'
              : dialog === 'account'
                ? '투자 계좌 추가'
                : dialog === 'quote'
                  ? '시세·환율 입력'
                  : dialog === 'detail'
                    ? '선택 자산'
                    : '거래 취소'
          }
          close={close}
        >
          {dialog === 'entry' && (
            <EntryForm
              book={book}
              initial={prefill}
              fx={fx}
              onClose={close}
              onSave={(entry) =>
                save({ action: 'event', entry, create: !edit, request: crypto.randomUUID() })
              }
            />
          )}
          {dialog === 'detail' && detailPanel}
          {dialog === 'cancel' && edit && (
            <>
              <p>이 거래를 취소하고 이후 잔액과 원가를 다시 계산합니다.</p>
              <button
                disabled={saving}
                onClick={async () => {
                  setSaving(true)
                  try {
                    await save({
                      action: 'event',
                      entry: { ...edit, cancelled: true },
                      create: false,
                      request: crypto.randomUUID(),
                    })
                    close()
                  } catch (e) {
                    setError((e as Error).message)
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                취소 확정
              </button>
            </>
          )}
          {(dialog === 'account' || dialog === 'quote') && (
            <form
              className="iv-form"
              onSubmit={async (e) => {
                e.preventDefault()
                const f = new FormData(e.currentTarget)
                setSaving(true)
                setError('')
                try {
                  if (dialog === 'account')
                    await save({ action: 'account', name: String(f.get('name')).trim() })
                  else {
                    const cur = String(f.get('currency')).toUpperCase(),
                      sym = String(f.get('symbol')).trim().toUpperCase(),
                      value = String(f.get('value'))
                    if (
                      !/^[A-Z]{3}$/.test(cur) ||
                      !/^([A-Z0-9][A-Z0-9.:-]{0,39})?$/.test(sym) ||
                      dec(value) <= 0n
                    )
                      throw Error('종목, 통화와 시세를 확인하세요.')
                    await save({
                      action: 'quote',
                      quote: {
                        key: keyOf(sym, cur),
                        value,
                        source: String(f.get('source')).trim(),
                        at: new Date(String(f.get('at'))).toISOString(),
                      },
                    })
                  }
                  close()
                } catch (ex) {
                  setError((ex as Error).message)
                } finally {
                  setSaving(false)
                }
              }}
            >
              {dialog === 'account' ? (
                <label>
                  계좌 이름
                  <input name="name" required maxLength={120} />
                </label>
              ) : (
                <>
                  <label>
                    티커 (환율은 비워 두세요)
                    <input name="symbol" defaultValue={row?.symbol} />
                  </label>
                  <label>
                    통화
                    <input name="currency" required defaultValue={row?.currency || 'USD'} maxLength={3} />
                  </label>
                  <label>
                    단가 또는 외화 1단위당 원화
                    <input name="value" inputMode="decimal" required />
                  </label>
                  <label>
                    기준 시각
                    <input
                      type="datetime-local"
                      name="at"
                      required
                      defaultValue={localDate(new Date().toISOString())}
                      step="1"
                    />
                  </label>
                  <label>
                    출처
                    <input required name="source" maxLength={120} />
                  </label>
                </>
              )}
              <button disabled={saving}>저장</button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
    </div>
  )
}
function currencyName(code: string) {
  return new Intl.DisplayNames('ko', { type: 'currency' }).of(code) || code
}
