# 개인 통합 금융 관리 프로젝트 — Q79 MVP 구현 패키지

> 상태: **구현 기준 초안 및 예제 코드**. 실제 Supabase 프로젝트에 배포하거나 DB 통합 테스트를 실행한 결과는 아니다.

## 포함 파일
| 경로 | 내용 |
|---|---|
| `supabase/migrations/202611240001_finance_core.sql` | 사용자별 계정·카테고리·원본 알림·대기 거래·확정 거래·복식부기 원장·감사 로그 + RLS + 승인 RPC |
| `supabase/tests/001_approval_smoke.sql` | 기본 승인, 균형 원장, 중복 승인 방지, 감사 로그 테스트 |
| `supabase/tests/002_cross_user_rls.sql` | 사용자 데이터 격리 테스트 |
| `supabase/tests/003_notification_and_owner.sql` | 알림 이벤트 재전송·타 사용자 승인 차단 테스트 |
| `src/lib/supabase/server.ts` | Next.js Supabase 서버 클라이언트 예시 |
| `src/app/api/pending-transactions/route.ts` | 미승인 거래 생성 API |
| `src/app/api/pending-transactions/[id]/approve/route.ts` | 사용자 승인 API |
| `docs/API_CONTRACT.md` | Android/Web/DB 공통 API 계약 |
| `docs/CODEX_PROMPT.md` | Codex Pro 2개·Claude 협업 개발 지시 |
| `docs/VALIDATION_AND_ROADMAP.md` | 실행 명령, 테스트, 미구현 사항, 다음 단계 |

## 통합 절차
1. 기존 Git 레포를 별도 브랜치로 체크아웃하고, 현재 폴더를 구조에 맞게 반영한다. **기존 인증 헬퍼는 확인 후 병합**한다.
2. Supabase CLI 개발 DB에서 `supabase start` 후 `supabase db reset`을 실행한다. `db reset`은 로컬 데이터를 초기화하므로 개발 환경에서만 수행한다.
3. SQL 테스트를 로컬 Postgres 연결로 실행한다. `psql` 및 Supabase CLI가 필요하다. 상세 방법은 `docs/VALIDATION_AND_ROADMAP.md`.
4. Next.js에서 `@supabase/ssr`, `@supabase/supabase-js`를 설치하고 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`를 설정한다. 기존 프로젝트에서 anon 키 변수를 쓰는 경우 맞춰서 교체한다.
5. 테스트 사용자로 `financial_accounts`, `categories`를 구성한 뒤 미승인 거래를 생성하고 승인한다.
6. Android 알림 수집 코드는 **아직 미포함**이다. `docs/CODEX_PROMPT.md`의 Codex #2 지시로 개발한다.

## 개발 원칙
- Android 거래 자동 수집 ≠ 자동 확정. 모든 원장 반영에는 사용자 승인 필요.
- 첫 MVP의 실제 구현 범위는 **원화 구매 승인**. 카드 대금 납부, 이체, 환불, 할부, 투자, 품목 다중 분할은 상세 규칙은 확보하되 코드 구현 후속.
- 확정 거래·원장은 클라이언트에서 직접 INSERT/UPDATE/DELETE하지 않고 RPC를 사용한다.
- 신용카드 구매는 비용 증가 + 카드 채무 증가. 체크카드 구매는 비용 증가 + 은행 자산 감소. 신용카드 대금 납부는 별도 후속 로직에서 비용 재인식 금지.
- 정밀 보안 설정(Q20)은 보류이나 기본 RLS/인증 및 서버 비밀키 보호는 필수.
- GPT API 사용 없이 SQL과 검증 규칙 중심으로 처리하므로 연간 ~$5 예산 목표에 부합한다. 실제 서비스 배포와 외부 API 비용은 별도 확인.

## 리스크 및 다음 작업
- 변경 불가능한 원장 `ledger_entries`의 UPDATE/DELETE 권한은 클라이언트에서 제거. DB 관리자 권한으로 직접 손대는 운영 절차도 제한해야 한다.
- 승인된 거래의 수정/환불은 **정정 전표를 만드는 별도 RPC**가 필요하다. 현재 없음.
- `notification_events.payload` 보관은 최소화/암호화/수명 관리를 추가해야 한다. Q74 영수증 파일 정책과 별개.
- Supabase/Next.js 패키지 버전, 기존 코드, 실제 인증/트리거, PostgreSQL 스키마와 충돌이 없는지 확인 필요.
- 현재 SQL의 유효성 및 DB 함수 실행 성공은 **환경 연결 전 미검증**. 테스트 파일은 재현용이며 성공했다고 주장하지 않는다.
