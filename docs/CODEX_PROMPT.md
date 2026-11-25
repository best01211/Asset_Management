# Codex 실행 지시서 — 개인 통합 금융 관리 Q79

아래 내용을 Codex에 그대로 전달하세요.

## 프로젝트 목표
Samsung Galaxy S23+ Android 알림 수신 → Supabase 미승인 거래 → 사용자 승인 → 차변/대변 균형 원장 → 확정 지출·잔액·예산으로 연결되는 MVP. 기존 Q1~Q19, Q21~Q24, Q26~Q73, Q75~Q79 결정은 유지. Q20 상세 보안 정책, Q25 빠른입력 UI, Q74 영수증 보관정책은 보류. 기본 인증·RLS는 보류 대상이 아님.

## 작업 규칙
1. 이 패키지를 코드베이스와 비교하고, 기존 테이블·라우트·인증 헬퍼를 확인한 뒤 **중복 구조를 만들지 말고** 통합 계획을 제시한다.
2. SQL 마이그레이션을 새 Supabase 로컬 DB에 적용하고, 세 SQL 테스트 실행을 확인한다. 기존 운영 DB에는 검토 없이 적용하지 않는다.
3. `approve_pending_expense()`는 JWT `auth.uid()`에만 의존하며 사용자 ID를 요청에서 받지 않는다. 임의의 service-role 키를 모바일·브라우저에 넣지 않는다.
4. 초기 구현 범위는 원화 카드·현금 **구매 거래 승인**이다. 이체/환불/할부/대출/투자 거래는 상세 구현 후속 단계이며 구현된 것처럼 표시하지 않는다.
5. 금액은 `bigint amount_minor` 원화 정수로 처리하고, JavaScript Number로 안전하게 처리 가능한 정수 범위를 넘지 않도록 검증한다. 초과 범위가 필요하면 문자열 기반 decimal 계약으로 변경한다.
6. DB 함수 승인 동작은 원자적으로 기록되며, 같은 pending 거래와 idempotency key의 재시도는 동일한 확정 거래 ID를 반환해야 한다.
7. 실제 거래 흐름 확인: (a) 신규 대기 거래는 지출·자산에 미반영 (b) 승인 후 두 분개가 균형 (c) 동일 승인 재요청에 원장 중복 없음 (d) 타 사용자 데이터 열람 금지.
8. 확인되지 않은 금융 원본 데이터는 임의로 보정하거나 자동 확정하지 않는다.

## 계정 분담
- Codex Pro #1 (DB·웹): 마이그레이션/RLS/승인 RPC/Next.js 라우트/통합테스트 담당. `supabase/`, `src/app/api/`, `src/lib/supabase/` 디렉터리를 책임진다.
- Codex Pro #2 (Android): Kotlin `NotificationListenerService`, 기기 내 미전송 큐, 안정적인 event ID, 사용자 인증된 HTTP 전송, 재시도 및 복구센터의 데이터 계약 담당. DB 스키마 직접 수정 금지. Android 파일만 수정한다.
- Claude: DB 경계/동시성/개인정보·금융 계산/테스트 커버리지 리뷰; 리뷰 내용은 코멘트로 제공하고 명세를 임의 변경하지 않는다.

## Codex #1 첫 번째 실행 지시
`supabase/migrations/202611240001_finance_core.sql` 파일을 검토하고 로컬 DB에 적용하라. `supabase/tests/001_approval_smoke.sql`, `002_cross_user_rls.sql`, `003_notification_and_owner.sql`을 `psql -v ON_ERROR_STOP=1`로 실행하고 결과를 기록하라. `src/app/api/pending-transactions/*`와 기존 Next.js 서버 인증 유틸을 통합하라. 인증 없이 호출한 경우 401, 충돌/오래된 승인 409, 정상 승인 200이 나오도록 API를 테스트하라. 배포 전에는 마이그레이션 중복/기존 컬럼 충돌 여부를 보고하라.

## Codex #2 첫 번째 실행 지시
현재 Android 프로젝트에서 NotificationListenerService로 사용자 허용을 받은 앱의 알림만 수신하는 Kotlin 계층을 구현하라. 같은 OS 알림이 업데이트되어 중복 통지되는 경우와 개별 결제 여러 건을 구별하도록 이벤트 키 전략을 제시하고 테스트하라. 알림 원문 저장은 최소화하고, 로컬 큐의 실패·재시도 상태를 분리하라. 로그인된 사용자 JWT를 이용해 `record_notification_event` RPC와 대기 거래 등록 API에 연결하되, **WebView 쿠키 인증을 네이티브 Retrofit 요청에 자동 재사용할 수 있다고 가정하지 말고** 인증 공유 방법을 별도 설계하라. 알림을 수신하지 못한 시간대의 결제는 자동 복원할 수 없다고 명시하라.

## 공통 API 계약
상세 내용은 `docs/API_CONTRACT.md`를 따른다. schema/API 호환 변경은 두 계정이 동일한 계약을 업데이트한 후 각각 반영해야 한다.

## 완료 보고
변경 파일 목록 / 적용 명령 / 성공한 테스트 / 실패하거나 미실행 테스트 / 남은 위험 / 단계별 체크리스트를 정확히 보고하라. 코드 실행이나 테스트를 하지 않았다면 완료라고 말하지 않는다.
