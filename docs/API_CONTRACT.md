# Q79 거래 승인 API 계약 (MVP v0.1)

## 설계 범위와 전제
- 범위: KRW 신용카드/체크카드/현금 **일반 구매** 1건 승인.
- 미포함: 환불/결제 취소/할부 정산/은행 이체/대출/외환/주식/여러 카테고리 분할 승인/확정 거래 정정. 확정된 기능은 **후속 단계**에서 구현하며, 본 패키지로 완성됐다고 주장하지 않는다.
- 인증: Supabase Auth 사용자 세션 기반. 모든 RPC의 user_id는 `auth.uid()`만 신뢰한다.
- 결제 알림 자동 수집은 Android Kotlin 네이티브 계층에서 담당. 웹과 모바일은 공통 거래 API를 사용.

## 계정 모델
- `financial_accounts.kind`: `asset`, `liability`, `expense`, `income`, `equity`.
- `credit_card` 구매 → payment account: `liability`(카드 미지급금), category expense account: `expense`.
- `debit_card` / `cash` 구매 → payment account: `asset`(예금/현금), category expense account: `expense`.
- 사용자는 필요한 계정과 카테고리를 사전 생성한다. 이 MVP는 opening balance/posting, 카드 결제대금 상환은 아직 지원하지 않는다.
- KRW 원화: `amount_minor`는 양의 정수 원 단위, 0/음수는 불허.

## 알림 수신 이벤트 RPC
`supabase.rpc('record_notification_event', { p_device_event_id, p_source_package, p_received_at, p_payload })`

최소 예시:
```json
{
  "p_device_event_id": "galaxy-s23plus:app-event-stable-id",
  "p_source_package": "com.example.cardapp",
  "p_received_at": "2026-11-24T13:05:00+09:00",
  "p_payload": { "merchant": "스타벅스", "amount_text": "5,500원" }
}
```
결과: 이벤트 UUID. 같은 사용자의 같은 `device_event_id` 재전송은 동일 UUID 반환. **이벤트 ID는 재시도에 안정적이어야 하며 결제의 고유 승인번호와 동일하다고 단정하면 안 된다.** 서버 측 allowlist/알림 출처 검증 강화는 Android 연동 단계의 필수 후속 작업.

## 미승인 거래 생성 API
`POST /api/pending-transactions`

```json
{
  "merchant": "스타벅스",
  "amount_minor": 5500,
  "occurred_at": "2026-11-24T13:05:00+09:00",
  "payment_method": "credit_card",
  "payment_account_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "category_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "notification_event_id": null
}
```

성공 `201`:
```json
{ "pending_transaction_id":"<uuid>", "status":"pending_review" }
```
- API는 현재 인증된 사용자의 `create_pending_expense` RPC를 호출한다.
- 알림 해석이 실패해 금액이 없을 때는 이 API로 만들어서는 안 된다. `notification_events`에 원본만 남기고 별도 재검토/복구 워크플로를 추가한다.
- 하나의 이벤트에 둘 이상의 대기 거래가 연결되는 것을 `(user_id, notification_event_id)` 유니크 제약으로 차단한다. 이 제약 때문에 **한 이벤트에 여러 건의 결제가 함께 포함되는 카드앱 형식**은 추후 별도 구조 설계가 필요하다.

## 승인 API
`POST /api/pending-transactions/{pendingId}/approve`

```json
{
  "expected_version": 1,
  "idempotency_key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

정상 승인 `200`:
```json
{
  "status": "confirmed",
  "transaction_id": "<uuid>",
  "ledger_posted": true,
  "replayed": false
}
```
같은 `pendingId`와 같은 `idempotency_key`로 재시도하면 `200`, `replayed=true`, 동일 transaction ID. 다른 idempotency key로 이미 확정된 거래에 재승인 시 `409`.

## 에러 상태
| HTTP | code | 설명 |
|---|---|---|
| 400 | INVALID_INPUT | 잘못된 요청 본문/UUID/버전/원화 금액 |
| 401 | UNAUTHORIZED | 세션 없음 |
| 404 | PENDING_NOT_FOUND | 사용자 소유 대기 거래 없음 |
| 409 | STALE_OR_NOT_REVIEWABLE | 이미 승인됐거나 검토 가능한 상태 아님, 버전 불일치 |
| 409 | IDEMPOTENCY_KEY_REUSED | 다른 pending에 사용한 요청 키 재사용 |
| 422 | ACCOUNT_CATEGORY_MISMATCH | 결제 수단과 자산/부채/비용 계정이 일치하지 않음 |
| 500 | APPROVAL_FAILED | 기타 데이터베이스/서버 오류. 상세 내부 오류 메시지 노출 금지 |

## 금융 원장 분개
- 신용카드 구매: DR expense, CR card payable.
- 체크카드/현금 구매: DR expense, CR asset.
- `ledger_entries`에서 각 transaction별 debit 합계 = credit 합계.
- 사용자 승인 전 `transactions`/`ledger_entries` 없음.
- 사용자가 일괄 승인하더라도 실패한 일부 항목을 자동으로 확정한 것으로 간주하지 않음. 현재는 단건 승인만 구현됨.
- `transaction_splits`는 초기에는 전체 금액을 한 카테고리에 배분. 영수증 Q73 다중 품목 분할은 후속 단계.

## 이벤트·거래의 구별
`notification_events`는 OS에서 수신한 원본 알림 이벤트. `pending_transactions`는 앱이 추론한 사용자 검토 후보. `transactions`는 사용자 승인 이후 회계 이벤트. 결제 완료가 곧 해당 계좌의 서버 잔고 조회와 일치한다는 보장은 없으므로 향후 대사/잔액 보정은 별도 처리한다.

## 최종 안전 조건
1. 익명 RPC는 모두 거절한다.
2. 사용자 입력으로 `user_id`, 원장 분개 금액, `confirmed_transaction_id`를 직접 변경할 수 없다.
3. 승인 재시도 및 동시 승인에서 분개 중복을 만들지 않는다.
4. 긴급 오류 시 확정 원장을 직접 UPDATE/DELETE하지 말고 정정 전표로 처리한다(정정 전표 API는 후속 작업).
5. Supabase Service Role Key는 브라우저·Android 앱 번들에 포함하지 않는다.
