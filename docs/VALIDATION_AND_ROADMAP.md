# Q79 검증 절차·개발 로드맵

## 실행 방법 (개발 환경에서만)

**사전 요구**: Docker, Supabase CLI, `psql` 또는 CLI의 Postgres 연결 수단, Node.js, Next.js 코드베이스.

```bash
# 프로젝트 루트에서 (로컬 Supabase)
supabase start
# SQL 마이그레이션 로컬 반영: 개발 DB 데이터를 초기화함
supabase db reset
# 아래는 로컬 DB의 psql 연결 주소를 환경에서 확인해 설정
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/001_approval_smoke.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/002_cross_user_rls.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/003_notification_and_owner.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/004_confirmed_ledger_integrity.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/005_notification_recovery.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/006_pending_expense_edit.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/007_duplicate_review.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/008_confirmed_ledger_summary.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/009_account_opening_balances.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/010_balance_checks_and_movements.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/011_balance_adjustments_and_transfer_fees.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/012_monthly_budgets.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/013_monthly_ledger_export.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/014_connected_purchase_setup.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/015_split_purchases_and_refunds.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/016_merchant_category_rules.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/017_confirmed_purchase_reversals.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/018_card_installments.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/019_card_benefits.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/020_purchase_receipts.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/021_monthly_financial_closings.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/022_purchase_csv_import.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/023_card_statement_settlement.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/024_investment_and_fx.sql
psql "$LOCAL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/025_receipt_attachment_policies.sql
```

테스트는 `BEGIN ... ROLLBACK`으로 종료해 변경 내용을 남기지 않는다. `set local role authenticated`와 `request.jwt.claim.sub`를 사용하므로 DB 소유자 권한으로 테스트를 실행해야 한다. 테스트 실행 시 역할 전환 권한이 없다면 전용 로컬 테스트 DB 역할을 구성한다.

원장 보호 마이그레이션은 카테고리가 같은 소유자의 비용 계정에 연결되도록 제한한다. 이전 초안에서 생성된 카테고리 중 다른 종류의 계정에 연결된 항목이 있으면, 원본을 확인하고 연결을 정정한 후 마이그레이션을 다시 실행한다.

**주의**: 기존 애플리케이션에 `transactions`, `categories` 등의 테이블이 이미 있다면 이 파일을 그대로 실행하지 않는다. 마이그레이션을 기존 스키마에 맞게 수정하고 정합성을 검토한다.

## 통합 검증 체크리스트
- [ ] 마이그레이션 문법·의존성·타입·기존 데이터 충돌 검증
- [ ] RLS: 다른 계정의 원장/알림/대기 거래 조회 불가
- [ ] RPC: 익명 호출 실패, 사용자 소유 확인
- [ ] 대기 거래는 원장과 확정 예산에 미반영
- [ ] 단일 분류 구매는 차변·대변 각 1개, 분할 구매는 비용 계정별 차변과 결제 계정 대변 1개, 두 경우 모두 차변·대변 합계 균형
- [ ] 같은 idempotency key 재시도에 기존 transaction 반환
- [ ] 다른 키의 재승인에 409 오류
- [ ] 2개 동시 승인 요청: 한 개만 확정되고 다른 요청은 충돌 처리
- [ ] 입력 불량/권한 오류/DB 실패 시 거래 원장 일부 반영 없음
- [x] 로컬 검증에서 카드 대금 납부·본인 계좌 이체의 지출 제외, 환불 원본 연결 및 누적 환불 한도 확인
- [ ] 복수 통화/품목 할인/오프라인 충돌 기능 미구현 표시

## 정합성 SQL 점검 예시
```sql
-- 차변/대변 잔액 점검 (조회 권한 있는 테스트 사용자로 실행)
select transaction_id,
       sum(case when side='debit' then amount_minor else 0 end) as debit_sum,
       sum(case when side='credit' then amount_minor else 0 end) as credit_sum
from public.ledger_entries
group by transaction_id
having sum(case when side='debit' then amount_minor else 0 end)
    <> sum(case when side='credit' then amount_minor else 0 end);
-- 기대: 0행
```

## 단계별 구현
1. **DB 검증**: 스키마/RLS/원장·승인 RPC·SQL 테스트 — Codex Pro #1.
2. **웹 거래 검토**: 확정 지출·대기 거래 분리 표시, 승인 버튼, 충돌 안내 — Codex Pro #1.
3. **Galaxy S23+ Android**: NotificationListenerService, 최소 알림 이벤트 추출, 로컬 큐, 안정적 event ID, 인증된 API 동기화 — Codex Pro #2.
4. **사용자 검토 UX**: 단건·일괄 승인, 대기 거래 수정, 중복 의심 비교 및 제외.
5. **금융 이벤트 확장**: 원화 카드 대금 납부, 부분 환불, 본인 계좌 이체와 수수료, 계좌 대조 및 차액 조정, 환불 이력이 없는 확정 구매의 역분개를 구현했다. 월별 할부 청구 계획, 수동 약관에 따른 정률 혜택 계산과 카드 명세서의 실제 청구·납부 연결을 제공한다.
6. **웹 기능 확장**: 영수증 품목·할인과 원본 첨부·OCR, 월말 결산, 원화 구매 CSV 가져오기, 수동 투자·외화 및 평가, 월간 보고서 API를 제공한다. 증권·카드사 자동 데이터 연동, 품목 단위 반품, AI 비서와 보고서 예약 발송은 후속 범위다. 확정 금액은 PostgreSQL과 검증 가능한 입력 자료에서 계산한다.

## 알려진 한계
- `npm run db:verify`는 마이그레이션과 SQL 테스트를 실행하고, 가상 사용자의 원장·결산·잔액을 논리 백업에서 별도 PGlite 인스턴스로 복원한다. 원본 값과 복원 값을 비교하고 다른 사용자에게 자료가 노출되지 않는지 확인한다. 가상 Storage 테이블에서 접근 정책을 검증한다.
- 새 Supabase 프로젝트에서 마이그레이션 23개와 구매 승인·사용자별 DB 접근·Storage 정책을 검증했다. 브라우저 인증 세션과 실제 파일 업로드의 통합 검증은 남아 있다. PostgreSQL 백업은 Storage에 저장된 영수증 파일 본체까지 가져오지 않으므로 파일 객체도 별도 백업·복원 검증 대상이다.
- Next.js 예제는 현재 버전의 쿠키 기반 `@supabase/ssr` 패턴을 가정한다. 기존 앱의 인증 Proxy 및 클라이언트 헬퍼와 통합이 필요하다.
- 고객 카드앱 알림 원본 텍스트를 서버에 장기 저장하는 것은 개인정보상 적절하지 않을 수 있다. 필요한 최소 데이터만 업로드하고 원문은 기기 내 암호화 보관 및 보존 기간 별도 결정 필요.
- Supabase Free/Vercel Hobby 가용량과 일정 실행 제약은 변경될 수 있으므로 배포 직전 재검증해야 한다.
- SQL의 허용된 원화 구매 승인 외 이벤트 종류에 원장 상태를 연결하려면 별도의 승인 함수, 검증, 테스트가 필요하다.
