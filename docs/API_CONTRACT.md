# Q79 거래 승인 API 계약 (MVP v0.1)

## 설계 범위와 전제
- 범위: KRW 신용카드·체크카드·현금 구매 승인 및 검토, 카테고리 분할, 초기 잔액·대조, 카드 대금 납부, 본인 계좌 이체, 구매 환불.
- 후속 범위에는 카드사 명세서 기반 할부 정산, 대출, 외환, 주식, 영수증 품목별 배분 및 확정 거래의 일반 정정이 포함된다.
- 인증: Supabase Auth 사용자 세션 기반. 모든 RPC의 user_id는 `auth.uid()`만 신뢰한다.
- 결제 알림 자동 수집은 Android Kotlin 네이티브 계층에서 담당. 웹과 모바일은 공통 거래 API를 사용.

## 계정 모델
- `financial_accounts.kind`: `asset`, `liability`, `expense`, `income`, `equity`.
- `credit_card` 구매 → payment account: `liability`(카드 미지급금), category expense account: `expense`.
- `debit_card` / `cash` 구매 → payment account: `asset`(예금/현금), category expense account: `expense`.
- 사용자는 필요한 계정과 카테고리를 사전 생성한다. 원화 자산·부채 계좌의 초기 잔액과 카드 대금 납부를 기록할 수 있다.
- KRW 원화: `amount_minor`는 양의 정수 원 단위, 0/음수는 불허.

## 알림 수집 및 복구 API

`POST /api/notification-events`는 이벤트와 대기 거래 후보를 하나의 DB 트랜잭션에서 처리한다. 웹은 인증 쿠키를, Android는 Supabase 사용자 액세스 토큰을 `Authorization: Bearer <token>`으로 보낸다.

실패한 파싱의 요청 예시

```json
{
  "device_event_id": "galaxy-s23plus:app-event-stable-id",
  "source_package": "com.example.cardapp",
  "received_at": "2026-11-25T08:00:00+09:00",
  "extraction": { "status": "failed", "error_code": "missing_fields" }
}
```

- 실패 코드는 `unrecognized_format`, `missing_fields`, `ambiguous_payment` 중 하나다. 원문 또는 추가 필드는 허용하지 않는다. 날짜는 시간대가 포함된 ISO 8601 형식이다.
- 파싱 성공 또는 수동 복구 시 같은 이벤트 정보와 `extraction.status: "parsed"`를 보낸다. `extraction`에는 `merchant`, `amount_minor`, `occurred_at`, `payment_method`, `payment_account_id`, `category_id`가 필요하다.
- 저장 또는 재전송 성공은 HTTP `200`과 `event_id`, `status`, `pending_transaction_id`, `error_code`를 반환한다. 상태는 `candidate_ready` 또는 `parse_failed`다. 계좌나 카테고리를 다시 골라야 할 때는 `parse_failed`와 `account_category_mismatch`를 반환한다.
- 이벤트 키, 출처 패키지, 최초 수신 시각을 기기에서 재전송마다 유지한다. 같은 이벤트에 일치하는 후보를 다시 제출하면 기존 후보 ID를 반환한다. 출처·최초 수신 시각 또는 이미 연결된 후보의 내용이 달라지면 `409 NOTIFICATION_EVENT_CONFLICT`를 반환한다.
- 다른 이벤트 키는 결제 항목이 같아도 각각의 대기 후보를 생성한다. 결제 중복 검토는 별도 흐름이다. 사용자 승인 전까지 확정 원장에는 반영하지 않는다.

`GET /api/notification-events`는 현재 사용자의 복구 대상만 반환한다. `events`에는 `event_id`, `device_event_id`, `source_package`, `received_at`, `status`, `error_code`가 포함된다. 이미 후보가 연결된 이벤트는 제외하며, 기존 미처리 이벤트의 상태는 `received`다. `limit` 기본값은 50이고 범위는 1~100이다. 다음 페이지는 `next_cursor`의 `before_received_at`과 `before_id`를 쿼리에 함께 넣어 조회한다.

### 기존 알림 이벤트 RPC
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
- 웹 수동 입력은 `request_id`를 추가할 수 있다. 알림 이벤트를 연결하지 않은 수동 요청에서 같은 UUID와 원본 내용으로 재시도하면 현재 거래 상태와 기존 ID를 반환하고, 내용이 다르면 `409 MANUAL_REQUEST_CONFLICT`를 반환한다.
- 새 Android 수집·재제출은 한 번의 `POST /api/notification-events`를 사용한다. 이 경로는 실패를 별도로 저장하고 대기 후보 중복을 막는다.
- 하나의 이벤트에 둘 이상의 대기 거래가 연결되는 것을 `(user_id, notification_event_id)` 유니크 제약으로 차단한다. 이 제약 때문에 **한 이벤트에 여러 건의 결제가 함께 포함되는 카드앱 형식**은 추후 별도 구조 설계가 필요하다.

## 연결된 거래 검토 목록

`GET /api/pending-transactions`는 인증된 웹 세션에 속한 거래를 반환한다. `status`는 `pending_review`(기본), `duplicate_suspected`, `confirmed`, `dismissed` 중 하나다. 거래 시각과 ID의 내림차순이며 `limit` 기본값은 25, 범위는 1~100이다. 다음 페이지가 있으면 반환된 `next_cursor.before_occurred_at`과 `next_cursor.before_id`를 함께 보낸다.

`transactions`의 각 항목에는 가맹점, 결제 수단, 거래 시각과 통화, 계좌·카테고리 ID 및 이름, 상태와 버전이 포함된다. `amount_minor`는 큰 정수의 정확도를 유지하기 위해 문자열로 반환한다. 세션이 없으면 `401 UNAUTHORIZED`, 목록 조회에 실패하면 `500 TRANSACTION_LIST_FAILED`를 반환한다.

## 미승인 거래 수정 API

`PATCH /api/pending-transactions/{pendingId}`에 `expected_version`, `merchant`, `amount_minor`, `occurred_at`, `payment_method`, `payment_account_id`, `category_id`를 보낸다. 금액은 양의 십진 정수 문자열이며, 거래 시각에는 시간대가 필요하다. `GET /api/pending-transactions/options`는 현재 사용자의 활성 KRW 결제 계좌와 KRW 비용 계정에 연결된 카테고리를 반환한다.

저장 결과는 `200`과 `pending_transaction_id`, `status`, `version`이다. 실제 변경이 있는 경우 버전을 증가시키고 변경 전후 값을 감사 로그에 남긴다. 이전 버전이거나 검토 대기 상태가 아니면 `409 STALE_OR_NOT_REVIEWABLE`, 결제 수단·계좌·카테고리가 일치하지 않으면 `422 ACCOUNT_CATEGORY_MISMATCH`를 반환한다.

## 원화 구매 CSV 가져오기

`POST /api/pending-transactions/import-csv`는 인증된 사용자의 `text/csv` 요청을 처리한다. UTF-8(선택적 BOM), 128 KiB 이내, 데이터 1~100행을 지원한다. 헤더 순서는 다음과 같다.

```csv
merchant,amount_minor,occurred_at,payment_method,payment_account_id,category_id
```

금액은 양의 원 단위 정수다. 발생 시각은 시간대를 포함한 ISO 형식, 결제 수단은 `credit_card`, `debit_card`, `cash` 중 하나다. 계좌와 카테고리에는 사용자가 소유한 UUID를 사용한다. 쉼표·인용 부호·개행이 포함된 텍스트는 CSV 인용 규칙을 따른다.

한 행이라도 잘못되면 모든 변경이 롤백된다. `422 CSV_ROW_REJECTED`의 `row`는 헤더를 1로 세는 CSV 레코드 번호다. 성공하면 각 행의 `pending_transaction_id`, `status`, `replayed`, `row`를 반환한다. 같은 내용과 순서로 재전송하면 기존 ID를 반환한다. 같은 파일 안의 동일한 두 행은 각각의 거래 후보로 등록되며 기존 중복 검토에서 확인할 수 있다. CSV 가져오기는 거래를 승인하거나 원장에 기록하지 않는다.

## 영수증 품목과 구매 카테고리 분할

`GET /api/pending-transactions/{pendingId}/splits`는 분할과 선택할 수 있는 카테고리를 반환한다. `PUT`에는 `expected_version`과 `allocations` 배열을 보낸다. 분할 항목에는 `category_id`와 양의 정수 문자열 `amount_minor`가 필요하다. 서로 다른 2~30개 카테고리의 합계가 거래 금액과 일치해야 한다. 빈 배열로 분할을 해제하고 기존 단일 카테고리 방식으로 돌아갈 수 있다. 합계가 다르면 `422 PENDING_SPLIT_AMOUNT_MISMATCH`, 버전이 다르면 `409 STALE_OR_NOT_REVIEWABLE`를 반환한다.

`GET /api/pending-transactions/{pendingId}/receipt`는 거래 버전·상태·결제액·확정 거래 ID와 저장된 `receipt`를 반환한다. `PUT`은 `expected_version`과 `receipt`를 받는다. `receipt`에는 `source`(`manual` 또는 사용자가 검토를 마친 `ocr_reviewed`), `shipping_minor`, `discount_minor`, `points_minor`, `items` 배열(1~100개)이 필요하다. 품목 필드는 `label`, `category_id`, `gross_minor`, `discount_minor`다. 금액은 원 단위 문자열이다.

품목별 할인 후 금액 합계에 배송비를 더하고 주문 할인과 포인트를 빼면 결제액과 일치해야 한다. 결제액은 품목별 할인 후 금액에 비례해 배분한다. 1원 미만의 잔여가 큰 품목부터 1원씩 배정하며, 잔여가 같으면 품목 입력 순서를 사용한다. 응답의 각 품목은 배분한 금액을 `net_minor`로 반환한다. 완전히 할인된 품목은 영수증에 남으며 0원 분개는 만들지 않는다.

영수증 저장은 기존 대기 카테고리 분할을 교체한다. 영수증이 연결된 동안에는 수동 분할을 변경하면 `409 RECEIPT_CONTROLS_SPLITS`를 반환한다. 대기 중 `receipt: null`을 보내면 영수증과 파생 분할을 함께 해제한다. 승인 뒤 품목은 읽을 수 있으며 수정은 거절된다. 결제액 불일치는 `422 RECEIPT_TOTAL_MISMATCH`, 사용할 수 없는 카테고리는 `422 RECEIPT_CATEGORY_INVALID`를 반환한다.

## 중복 거래 비교 및 검토

`GET /api/pending-transactions/{pendingId}/duplicates`는 현재 거래에 연결된 `linked_id`와 비교 후보 `candidates`를 반환한다. 후보는 같은 통화와 금액의 전후 72시간 이내 거래를 최대 20건 표시한다. 이름이 같은 가맹점과 거래 시각이 가까운 후보를 우선한다.

`POST /api/pending-transactions/{pendingId}/duplicates`는 `expected_version`과 `action`을 받는다. `flag`는 비교 상대의 `reference_id`가 필요하다. `keep`은 검토 대기로 되돌리고, `dismiss`는 연결된 비교 상대를 확인한 뒤 제외한다. 결과는 `status`와 `version`이며, 참조 관계가 유효하지 않으면 `422 DUPLICATE_REFERENCE_INVALID`를 반환한다. 상태 변경과 연결 관계는 감사 이력에 기록한다.

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

### 선택 일괄 승인

`POST /api/pending-transactions/batch-approve`에 `items` 배열을 보내며, 각 항목은 `id`, `expected_version`, `idempotency_key`를 갖는다. 한 요청에 1~20건을 보낼 수 있고, 거래 ID와 요청 키는 배열 안에서 각각 유일해야 한다.

유효한 요청은 `200`과 입력 순서의 `results`를 반환한다. 결과마다 `id`, `status`, `body`가 있으며 상태와 본문은 단건 승인 API와 같은 형식이다. 각 항목은 독립된 승인 트랜잭션으로 처리되므로 성공한 거래는 확정되고, 충돌이나 기타 오류가 있는 항목은 별도 결과로 표시된다.

## 에러 상태
| HTTP | code | 설명 |
|---|---|---|
| 400 | INVALID_INPUT | 잘못된 요청 본문/UUID/버전/원화 금액 |
| 401 | UNAUTHORIZED | 세션 없음 |
| 404 | PENDING_NOT_FOUND | 사용자 소유 대기 거래 없음 |
| 409 | STALE_OR_NOT_REVIEWABLE | 이미 승인됐거나 검토 가능한 상태 아님, 버전 불일치 |
| 409 | IDEMPOTENCY_KEY_REUSED | 다른 pending에 사용한 요청 키 재사용 |
| 409 | NOTIFICATION_EVENT_CONFLICT | 같은 알림 이벤트 키에 다른 출처, 최초 수신 시각 또는 후보 내용 제출 |
| 422 | ACCOUNT_CATEGORY_MISMATCH | 결제 수단과 자산/부채/비용 계정이 일치하지 않음 |
| 500 | APPROVAL_FAILED | 기타 데이터베이스/서버 오류. 상세 내부 오류 메시지 노출 금지 |
| 500 | NOTIFICATION_INGESTION_FAILED / NOTIFICATION_RECOVERY_FAILED | 알림 저장 또는 복구 목록 조회 중 서버 오류 |
| 503 | SUPABASE_NOT_CONFIGURED | API 서버에 Supabase 프로젝트 URL 또는 publishable key 미설정. 대기 거래 생성 API에도 적용 |

## 금융 원장 분개
- 신용카드 구매: DR expense, CR card payable.
- 체크카드/현금 구매: DR expense, CR asset.
- `ledger_entries`에서 각 transaction별 debit 합계 = credit 합계.
- 사용자 승인 전 `transactions`/`ledger_entries` 없음.
- 일괄 승인에서 거래별 확정·실패·확인 필요 결과를 구분한다.
- `transaction_splits`는 확정 구매의 카테고리별 비용을 기록한다. 다중 카테고리 분할의 합계와 비용 분개는 거래 금액과 일치해야 한다. 영수증 품목의 할인·포인트 배분은 후속 범위다.

### 확정 원장 집계

웹의 `/ledger-summary`는 사용자 세션으로 `summarize_confirmed_purchases(p_month)`를 호출한다. 한국 시간 기준 확정 KRW 구매 건수·구매액·환불액·순지출, 카테고리별 순지출과 자산·부채 계좌 증감을 반환한다. 지출은 환불 처리 월에 원본 구매의 카테고리에서 차감된다. 카드 대금 납부와 본인 계좌 이체는 계좌 증감에 반영한다. 금액은 정수 문자열이다.

### 계좌 초기 잔액과 계산 잔액

`GET /api/account-balances`는 사용자의 원화 자산·부채 계좌와 초기 잔액, 기준 시각, 원장 증감 및 계산 잔액을 반환한다. 초기 잔액 미등록 계좌의 계산 잔액은 `null`이다. 초기 잔액의 기준 시각부터 현재까지의 확정 거래를 반영한다.

`POST /api/account-balances`는 `account_id`, 0 이상의 정수 문자열 `amount_minor`, 시간대를 포함한 과거 또는 현재의 `effective_at`을 받는다. 계좌별 한 번 기록하며, 같은 내용의 재요청은 기존 결과를 반환한다. 금액 또는 시각이 다른 재요청은 `409 OPENING_BALANCE_ALREADY_RECORDED`로 응답한다. 0원은 기준 기록만 생성하고, 양수 금액은 자산·부채와 자본 계정에 복식 분개한다. 초기 잔액은 구매 지출 집계에서 제외한다.

### 실제 잔액 대조와 주요 금융 거래

`GET /api/account-activity`는 계좌와 최근 대조 기록을 조회한다. `purchase_id`를 지정하면 해당 사용자의 원본 구매와 환불 가능액, 환불·정정 여부도 반환한다.

`POST /api/account-activity`의 공통 필드는 `kind`, 정수 문자열 `amount_minor`, 시간대를 포함한 `at`, UUID `request_id`다. 한 사용자의 동일 요청 ID를 같은 내용으로 다시 보내면 기존 결과를 반환한다. 내용이 다르면 HTTP `409`로 응답한다.

| kind | 추가 필드와 동작 |
|---|---|
| `balance_check` | `account_id`와 실제 잔액. 기준 시각의 원장 잔액과 `실제 - 원장` 차이를 기록한다. 조정 전표는 생성하지 않는다. |
| `card_payment` | `from_account_id`(자산), `to_account_id`(부채). 자산과 카드 부채를 함께 줄인다. |
| `own_transfer` | 서로 다른 자산 계좌의 `from_account_id`, `to_account_id`. `fee_minor` 기본값은 `"0"`이다. 수수료가 있으면 `fee_category_id`가 필요하며 원금·수수료가 함께 확정된다. |
| `purchase_refund` | `original_purchase_id`. 원본 계좌와 비용의 반대 분개를 기록한다. 누적 환불 한도는 원본 구매액이다. 부분 환불은 각 카테고리의 남은 금액에 비례해 배분하며, 1원 미만 잔여분은 나머지가 큰 순서로 배정한다. 나머지가 같으면 카테고리 ID 순서를 사용한다. |

차액 조정은 같은 API에 `kind: "balance_adjustment"`와 `balance_check_id`만 보낸다. 승인 직전에 확인 시각의 원장 잔액을 다시 계산하고, 저장된 대조 금액이 달라졌거나 이후 날짜의 조정이 이미 있으면 `409 BALANCE_CHECK_STALE`를 반환한다. 조정은 계좌와 자본 계정에 분개하며 지출 합계에서 제외한다.

잘못 입력한 확정 구매를 정정하려면 같은 API에 `kind: "purchase_reversal"`, `original_purchase_id`, 정정 사유 `reason`(1~200자)을 보낸다. 원본 구매일에 정확한 역분개를 생성하고 원본 구매와 연결한다. 같은 사유로 재시도하면 기존 정정 ID를 반환한다. 사유가 다르거나 이미 환불한 구매는 각각 `409 PURCHASE_ALREADY_REVERSED`, `409 PURCHASE_HAS_REFUNDS`로 응답한다. 정정 전표의 CSV `original_purchase_id`에 원본 구매 ID가 표시된다.

### 카드 할부 청구 계획

`PUT /api/card-installments`는 `purchase_id`, 현재 `version`(최초 0), `first_month`(`YYYY-MM`), `payment_count`(2~60), 원 단위 문자열 `principal_minor`와 `fee_minor`를 받는다. 해제할 때는 날짜·회차·금액 필드 모두에 `null`을 보낸다. 다른 화면에서 수정한 경우 `409 INSTALLMENT_VERSION_CONFLICT`를 반환한다.

`get_card_installment_plan`과 `list_card_installments`는 소유자의 확정 원화 신용카드 구매를 조회한다. 원금과 예상 수수료의 원 단위 잔여분은 앞 회차부터 1원씩 배정한다. 환불 이후 확인이 필요한 계획은 합계에서 제외하고, 구매 정정 시 월별 계획에서 제외한다. 실제 청구·납부와 기존 원장 분개는 별도로 처리한다.

### 카드 혜택

`POST /api/card-benefits`는 공통으로 `card_id`, `category_id`(미지정 시 `null`)를 받는다.

- `action: "register"`는 `request_id`, `effective_from`, `effective_until`(없으면 `null`), `source`, `rate_bps`(7.5%는 750), `prior_spend_minor`, `monthly_cap_minor`(무제한이면 `null`)를 받는다. 같은 요청 ID와 내용을 다시 보내면 저장된 버전을 반환한다.
- `action: "estimate"`는 `purchase_date`, `eligible_amount_minor`, `prior_eligible_minor`, `used_benefit_minor`를 받는다. 금액은 원 단위 문자열이다. 구매 예정일의 약관 버전과 출처, 예상 혜택, 적용 여부와 남은 월 한도를 반환한다. 혜택 금액은 원 단위로 내림하며 실제 지급·원장과 분리한다.

### 월말 결산 버전

- `GET /api/monthly-closings?month=YYYY-MM`은 가장 최근에 저장한 결산과 현재 원장 기준 결산을 반환한다. `version`을 지정하면 해당 버전을 현재 값과 비교한다.
- `POST /api/monthly-closings`는 `month`와 `expected_version`(최초 0)을 받는다. 한국 시간 기준으로 지나간 달을 결산할 수 있다. 현재 값이 이전 결산과 달라졌을 때 새 버전을 추가한다.
- 응답은 `latest_version`, `saved`, `current`, `changed`를 포함한다. 스냅샷은 원장 집계와 월간 예산, 월말 원화 자산·부채 잔액, 확인 가능한 계좌만 반영한 순자산 및 미확인 잔액 건수를 포함한다. 월 경계는 한국 시간이며 기간 표시는 UTC다.
- 과거 버전 부재는 `404 CLOSING_VERSION_NOT_FOUND`, 버전 충돌은 `409 CLOSING_VERSION_CONFLICT`, 진행 중이거나 미래의 월은 `422 CLOSING_MONTH_IN_PROGRESS`를 반환한다.

### 월별 예산과 CSV 내보내기

- `GET /api/budgets?month=YYYY-MM`는 전체 예산과 카테고리별 예산·확정 순지출을 반환한다. `PUT /api/budgets`는 `month`, `category_id`(전체 예산은 `null`), `amount_minor`(해제 시 `null`), `expected_version`을 받는다. 존재하지 않는 예산의 초기 버전은 0이다. 해제 후에도 서버 버전을 유지한다.
- `GET /api/ledger-export?month=YYYY-MM&kind=transactions|entries`는 인증된 사용자의 월별 확정 거래 또는 분개 CSV를 내려준다. 월 구분은 한국 시간이며 CSV의 시각 값은 UTC다. 초기 잔액과 비지출 금융 기록도 내보내기에 포함한다.
- `GET /api/finance-settings`는 현재 사용자의 원화 결제 계좌와 비용 카테고리를 반환한다. `POST`는 `type`(`account` 또는 `category`)과 `name`을 받으며, 계좌에는 `kind`(`asset` 또는 `liability`)가 필요하다.
- `GET /api/category-rules`는 개인 가맹점 규칙과 카테고리 목록을 반환한다. `POST`의 `action: "save"`는 `merchant`, `category_id`를 받고, `category_id: null`로 해제한다. `action: "match"`는 가맹점의 대소문자와 앞뒤 공백을 정규화해 정확히 일치하는 카테고리를 제안한다. 이미 선택한 분류와 기존 거래는 변경하지 않는다.

## 이벤트·거래의 구별
`notification_events`는 OS에서 수신한 원본 알림 이벤트. `pending_transactions`는 앱이 추론한 사용자 검토 후보. `transactions`는 사용자 승인 이후 회계 이벤트. 결제 완료가 곧 해당 계좌의 서버 잔고 조회와 일치한다는 보장은 없으므로 향후 대사/잔액 보정은 별도 처리한다.

## 투자 거래·환전

`GET /api/investments`는 사용자 증권 계좌를 나열한다. `account_id`를 보내면 보유 수량, 원화 이동평균 원가, 실현손익, 순배당, 통화별 순현금 이동을 조회한다. 투자 워크스페이스 마이그레이션 이후에는 입출금·계좌 이동과 거래 정정도 반영한다.

`GET /api/investments/workspace`는 인증 사용자의 계좌, 유효 거래(취소 표시 포함), 자산별 마지막 시세를 반환한다. `asset=티커|통화`는 선택 종목의 시세 이력, `asset=analysis`는 기간 비교용 시세 이력을 포함한다. 같은 경로의 POST는 `account`, `event`, `quote`, `refresh`를 받는다. 거래의 `request`는 요청 UUID, `entry.id`는 원본 거래 UUID, `entry.version`은 마지막 조회 버전이다. 신규는 `create: true`, 정정은 다음 버전 추가, 취소는 `entry.cancelled: true`를 사용한다. 잔액·수량 부족은 422, 버전 충돌은 409다.

- `POST /api/investments`의 `action: "account"`는 계좌 `name`을 받는다.
- `action: "event"`는 `account_id`, `request_id`, `event`를 받는다. 이벤트에는 `kind`(`buy`, `sell`, `dividend`, `fx`), 시간대가 포함된 `occurred_at`, `currency`, `gross`, `fee`, `krw_per_unit`, `source`가 필요하다. 매수·매도는 `symbol`과 `quantity`, 배당은 `symbol`, 환전은 `target_currency`와 `target_amount`를 받는다. 수량과 금액, 환율은 소수 8자리 이하 문자열이다. 원화 환율은 1을 사용한다. 매수·매도는 계좌·종목·통화별 체결 순서대로 기록한다.
- `action: "value"`는 `account_id`와 최대 100개의 `quotes`를 받는다. 각 인용에는 `symbol`, `currency`, `unit_price`, `krw_per_unit`, `as_of`, `source`가 필요하다. 평가 금액은 입력한 가격 기준이며, 시세가 빠진 종목의 가치는 미확인으로 반환한다.

## 카드 명세서 정산

- `GET /api/card-statements?month=YYYY-MM`은 카드사 실제 청구액, 입력된 실제 혜택, 연결된 납부액과 미납액을 조회한다.
- `POST /api/card-statements`의 `action: "register"`는 `card_id`, `month`, `due_on`, `billed_minor`, 선택적 `benefit_minor`, `source`를 받는다. 동일 카드·월의 동일 입력을 다시 보내면 기존 명세서 ID를 반환한다.
- `action: "allocate"`는 `statement_id`, 기존 카드 납부 전표의 `payment_id`, 원 단위 문자열 `amount_minor`를 받는다. 0은 연결 해제다. 명세서 청구액과 기존 납부액을 초과해서 배분할 수 없다. 연결 기록은 생활비나 카드 납부를 다시 분개하지 않는다.

## 영수증 원본과 OCR

기존 대기 거래 ID를 사용한다. `POST /api/pending-transactions/{id}/attachments?request_id={uuid}`는 JPEG·PNG·PDF 본문을 최대 4 MiB까지 저장한다. `GET`으로 첨부 목록을 보고, `file`을 지정해 원본을 내려받는다. 같은 이름으로 다른 파일을 덮어쓸 수 없다.

`POST /api/pending-transactions/{id}/attachments/ocr?file={name}`은 PDF 최대 5쪽 또는 이미지 한 장을 처리한다. PDF에 추출 가능한 텍스트가 있으면 해당 텍스트를 사용하고, 스캔 페이지와 사진에는 한국어·영어 OCR을 실행한다. 응답의 `requires_review`가 참이며, 검토를 마친 품목은 별도의 영수증 품목 API로 저장한다.

## 월간 보고서

`GET /api/monthly-reports?month=YYYY-MM&format=csv|xlsx|pdf`는 월 지출·예산·원화 계좌 잔액과 카드 명세서를 다운로드한다. `version`을 지정하면 원장·예산·잔액은 해당 결산 버전으로 출력된다. 카드 명세서는 조회 시점의 상태임을 보고서에 표시한다.

## 최종 안전 조건
1. 익명 RPC는 모두 거절한다.
2. 사용자 입력으로 `user_id`, 원장 분개 금액, `confirmed_transaction_id`를 직접 변경할 수 없다.
3. 승인 재시도 및 동시 승인에서 분개 중복을 만들지 않는다.
4. 잘못 기록한 확정 구매는 원본과 정정 사유를 보존하고 역분개로 처리한다.
5. Supabase Service Role Key는 브라우저·Android 앱 번들에 포함하지 않는다.

투자 화면의 공개 시세 조회는 계좌 식별자나 수량 없이 `POST /api/investments/market`에 `instruments`를 전달한다. 선택 필드 `through`를 YYYY-MM-DD 형식으로 보내면 해당 한국 날짜까지의 180일 범위에서 완료된 일봉을 조회한다. 응답은 `quotes`와 조회에 실패한 종목·통화 목록 `missing`을 포함한다.
