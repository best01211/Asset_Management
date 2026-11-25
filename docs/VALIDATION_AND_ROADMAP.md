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
```

테스트는 `BEGIN ... ROLLBACK`으로 종료해 변경 내용을 남기지 않는다. `set local role authenticated`와 `request.jwt.claim.sub`를 사용하므로 DB 소유자 권한으로 테스트를 실행해야 한다. 테스트 실행 시 역할 전환 권한이 없다면 전용 로컬 테스트 DB 역할을 구성한다.

**주의**: 기존 애플리케이션에 `transactions`, `categories` 등의 테이블이 이미 있다면 이 파일을 그대로 실행하지 않는다. 마이그레이션을 기존 스키마에 맞게 수정하고 정합성을 검토한다.

## 통합 검증 체크리스트
- [ ] 마이그레이션 문법·의존성·타입·기존 데이터 충돌 검증
- [ ] RLS: 다른 계정의 원장/알림/대기 거래 조회 불가
- [ ] RPC: 익명 호출 실패, 사용자 소유 확인
- [ ] 대기 거래는 원장과 확정 예산에 미반영
- [ ] 정상 승인 후 차변/대변 각 1개, 합계 균형
- [ ] 같은 idempotency key 재시도에 기존 transaction 반환
- [ ] 다른 키의 재승인에 409 오류
- [ ] 2개 동시 승인 요청: 한 개만 확정되고 다른 요청은 충돌 처리
- [ ] 입력 불량/권한 오류/DB 실패 시 거래 원장 일부 반영 없음
- [ ] 카드 대금 납부/환불 구현 전에는 해당 거래 유형 생성 기능 노출 금지
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
4. **사용자 검토 UX**: 일괄 승인(현재 SQL 단건만 제공하므로 추가 RPC), 재분류, 중복 의심 목록.
5. **금융 이벤트 확장**: 카드 대금 상환, 신용카드 부분 취소, 은행 이체, 할부, 계좌 대사, 원장 정정, 카드 혜택.
6. **후속 단계**: 투자·환율·영수증 품목 분할·AI 비서·보고서. GPT API를 SQL 계산에 사용하지 않음.

## 알려진 한계
- 마이그레이션과 예제 API는 이 대화에서 생성했으며 실제 Supabase 프로젝트에 적용하거나 런타임 테스트를 하지 않았다.
- Next.js 예제는 현재 버전의 쿠키 기반 `@supabase/ssr` 패턴을 가정한다. 기존 앱의 인증 Proxy 및 클라이언트 헬퍼와 통합이 필요하다.
- 고객 카드앱 알림 원본 텍스트를 서버에 장기 저장하는 것은 개인정보상 적절하지 않을 수 있다. 필요한 최소 데이터만 업로드하고 원문은 기기 내 암호화 보관 및 보존 기간 별도 결정 필요.
- Supabase Free/Vercel Hobby 가용량과 일정 실행 제약은 변경될 수 있으므로 배포 직전 재검증해야 한다.
- SQL의 허용된 원화 구매 승인 외 이벤트 종류에 원장 상태를 연결하려면 별도의 승인 함수, 검증, 테스트가 필요하다.
