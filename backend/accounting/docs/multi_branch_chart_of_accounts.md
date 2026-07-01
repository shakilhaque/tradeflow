# Multi-Branch Chart of Accounts — Design

## TL;DR

Two new columns, one new convention, three new reports. Tenant DBs stay
isolated (one Postgres DB per tenant — see `accounts/tenant_db.py`); this
design plugs into each tenant DB independently. No master-DB schema
touched.

```
+---------------------+       +-----------------------+
|     accounts        |       |    journal_entries    |
|---------------------|       |-----------------------|
| id                  |       | id                    |
| code         (UNIQ) |       | entry_number  (UNIQ)  |
| name                |       | reference_type        |
| account_type        |       | reference_id          |
| is_contra           |       | date                  |
| is_system           |       | description           |
| is_global    (NEW)  |       | created_by_id         |
| location_id  (NEW)  +<-+    | created_at            |
| is_active           |  |    +-----------+-----------+
| parent_id           |  |                |
+---------+-----------+  |                |
          |              |    +-----------v-----------+
          |              |    | journal_entry_lines   |
          |              |    |-----------------------|
          |              |    | id                    |
          +--------------+----+ account_id            |
                              | location_id   (NEW)   +-+
                              | debit                 | |
                              | credit                | |
                              | description           | |
                              +-----------------------+ |
                                                        |
+---------------------+                                 |
|     locations       |<--------------------------------+
|---------------------|
| id                  |
| name                |
| code         (UNIQ) |
| is_active           |
+---------------------+
```

Two integrity rules in the database, one in the service layer:

1. **DB CHECK** — `account.is_global = TRUE ⟺ account.location_id IS NULL`.
   Enforced as a `CheckConstraint`.
2. **Service** — every `journal_entry_lines.location_id` is required at
   the API boundary (column allows NULL only to keep legacy pre-locality
   rows valid).
3. **Service** — when a line touches a branch-scoped account
   (`account.is_global = FALSE`), the line's `location_id` MUST equal
   `account.location_id`. Refused with `JournalLocalityError`.

## 1. Account locality

```sql
-- One column distinguishes shared from branch-scoped:
ALTER TABLE chart_of_accounts
  ADD COLUMN is_global BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN location_id UUID NULL
      REFERENCES locations(id) ON DELETE RESTRICT;

CREATE INDEX acct_locality_idx ON chart_of_accounts (is_global, location_id);

ALTER TABLE chart_of_accounts
  ADD CONSTRAINT account_locality_consistent
  CHECK (
       (is_global = TRUE  AND location_id IS NULL)
    OR (is_global = FALSE AND location_id IS NOT NULL)
  );
```

| Account                       | `account_type` | `is_global` | `location_id` |
| ----------------------------- | -------------- | ----------- | ------------- |
| Central Bank                  | ASSET          | `TRUE`      | `NULL`        |
| Central bKash                 | ASSET          | `TRUE`      | `NULL`        |
| Sales — Income                | INCOME         | `TRUE`      | `NULL`        |
| Sales Tax Payable             | LIABILITY      | `TRUE`      | `NULL`        |
| **Cash in Hand — Branch A**   | ASSET          | `FALSE`     | `<branch-a>`  |
| **Cash in Hand — Branch B**   | ASSET          | `FALSE`     | `<branch-b>`  |
| **Petty Cash — Branch A**     | ASSET          | `FALSE`     | `<branch-a>`  |

Cashier at Branch B who tries to debit "Cash in Hand — Branch A" is
rejected by `post_balanced_entry` with a `JournalLocalityError`. The
physical drawer is safe.

## 2. Transaction-level location tag

```sql
ALTER TABLE journal_entry_lines
  ADD COLUMN location_id UUID NULL    -- NULL allowed for legacy rows
      REFERENCES locations(id) ON DELETE RESTRICT;

CREATE INDEX jel_loc_account_idx ON journal_entry_lines (location_id, account_id);
```

> **Every new journal line gets `location_id` populated** with the branch
> where the underlying transaction physically occurred. The account it
> hits is irrelevant to this tag — that's the whole point.

## 3. Pseudo-code — sale at Branch A paid via central bKash

A customer buys `৳1,000` of goods at **Branch A**, pays via the central
bKash account. COGS is `৳600`.

```
TRANSACTION BEGIN

  je = JournalEntry.create(
    reference_type = SALE,
    reference_id   = sale.id,
    description    = f"Sale #{sale.invoice_number} @ {branch_a.name}",
    date           = today,
  )

  # Sale recognition
  JournalEntryLine.create(je, Central_bKash,        location=branch_a, debit=1000)   # ← global asset, tagged to Branch A
  JournalEntryLine.create(je, Sales_Income,         location=branch_a, credit=1000)  # ← global income, tagged to Branch A

  # COGS recognition
  JournalEntryLine.create(je, COGS,                 location=branch_a, debit=600)
  JournalEntryLine.create(je, Inventory_Asset,      location=branch_a, credit=600)

  assert Σdebit == Σcredit   # 1600 == 1600

TRANSACTION COMMIT
```

After commit:

| Effect                                                  | Where seen                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Central bKash balance grows by ৳1,000                   | `SELECT balance FROM chart_of_accounts WHERE code='1020';` |
| Branch A's contribution to bKash this month grows ৳1,000 | `/api/accounting/reports/branch/contribution/?location_id=<branch_a>` |
| Branch A's P&L revenue grows by ৳1,000                  | `/api/accounting/reports/branch/pnl/?location_id=<branch_a>` |
| Branch B's reports — unchanged                          | by construction (line.location_id = branch_a)              |

The same code in Python, using the helper this PR adds:

```python
from accounting.services import post_balanced_entry

post_balanced_entry(
    entry_number   = "JE-202606-0001",
    reference_type = "SALE",
    reference_id   = sale.id,
    description    = f"Sale #{sale.invoice_number} @ {branch_a.name}",
    date           = today,
    created_by_id  = cashier.id,
    location_id    = branch_a.id,         # ← the BRANCH, not the account
    lines = [
        {"account_id": central_bkash.id,    "debit":  Decimal("1000")},
        {"account_id": sales_income.id,     "credit": Decimal("1000")},
        {"account_id": cogs_account.id,     "debit":  Decimal("600")},
        {"account_id": inventory_asset.id,  "credit": Decimal("600")},
    ],
)
```

`post_balanced_entry` validates: every line tagged → check; balance →
check; branch-scoped accounts only used from their home branch → check.

## 4. Query templates

### 4.1 Total global balance of a shared bank account

`Account.get_balance()` does this automatically; here's the SQL it runs.

```sql
-- Central bKash, no location filter → total cross-branch balance.
SELECT
  COALESCE(SUM(jel.debit), 0)  AS total_debit,
  COALESCE(SUM(jel.credit), 0) AS total_credit,
  COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS balance
  -- (subtract reversed for credit-normal accounts;
  --  ASSET is debit-normal so DR − CR is the natural balance)
FROM journal_entry_lines jel
JOIN journal_entries     je ON je.id = jel.journal_entry_id
WHERE jel.account_id = :central_bkash_id
  AND je.date <= :as_of_date;
```

API: `GET /api/accounting/reports/global-account-balance/?account_id=<bkash>`

### 4.2 Localised P&L for one branch

```sql
WITH net AS (
  SELECT
    coa.account_type,
    SUM(jel.debit)  AS dr,
    SUM(jel.credit) AS cr
  FROM journal_entry_lines jel
  JOIN journal_entries     je  ON je.id  = jel.journal_entry_id
  JOIN chart_of_accounts   coa ON coa.id = jel.account_id
  WHERE jel.location_id = :branch_id        -- ← the key filter
    AND je.date BETWEEN :date_from AND :date_to
  GROUP BY coa.account_type
)
SELECT
  -- INCOME is credit-normal, so revenue = CR − DR
  (SELECT COALESCE(cr, 0) - COALESCE(dr, 0) FROM net WHERE account_type='INCOME')  AS revenue,
  -- COGS/EXPENSE are debit-normal
  (SELECT COALESCE(dr, 0) - COALESCE(cr, 0) FROM net WHERE account_type='COGS')    AS cogs,
  (SELECT COALESCE(dr, 0) - COALESCE(cr, 0) FROM net WHERE account_type='EXPENSE') AS operating_expenses;
```

`gross_profit = revenue - cogs`,
`net_profit  = gross_profit - operating_expenses`.

API: `GET /api/accounting/reports/branch/pnl/?location_id=<branch>&date_from=…&date_to=…`

### 4.3 Branch contribution to global accounts

```sql
SELECT
  coa.id    AS account_id,
  coa.code  AS account_code,
  coa.name  AS account_name,
  coa.account_type,
  COALESCE(SUM(jel.debit),  0) AS total_debit,
  COALESCE(SUM(jel.credit), 0) AS total_credit
FROM journal_entry_lines jel
JOIN journal_entries     je  ON je.id  = jel.journal_entry_id
JOIN chart_of_accounts   coa ON coa.id = jel.account_id
WHERE coa.is_global    = TRUE
  AND jel.location_id  = :branch_id
  AND je.date BETWEEN :date_from AND :date_to
GROUP BY coa.id, coa.code, coa.name, coa.account_type
ORDER BY coa.code;
```

For each row, compute the net in the account's normal direction:

```
net_contribution = (debit  − credit)  if account_type IN ('ASSET','COGS','EXPENSE')
                   (credit − debit)   else                  -- INCOME/LIAB/EQUITY
```

API: `GET /api/accounting/reports/branch/contribution/?location_id=<branch>&date_from=…&date_to=…`

### 4.4 End-of-day cash reconciliation

```sql
-- Every branch-scoped ASSET account at this branch and its current balance.
SELECT
  coa.id, coa.code, coa.name,
  COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS balance
FROM chart_of_accounts coa
LEFT JOIN journal_entry_lines jel ON jel.account_id = coa.id
LEFT JOIN journal_entries     je  ON je.id  = jel.journal_entry_id AND je.date <= :as_of_date
WHERE coa.location_id  = :branch_id
  AND coa.account_type = 'ASSET'
  AND coa.is_active    = TRUE
GROUP BY coa.id, coa.code, coa.name
ORDER BY coa.code;
```

API: `GET /api/accounting/reports/branch/cash-reconciliation/?location_id=<branch>&date_to=…`

## 5. Tenant isolation — explicit reminder

Every table above (`chart_of_accounts`, `journal_entries`,
`journal_entry_lines`, `locations`) is **per-tenant**. Each tenant has
their own Postgres database (`saas_<slug>`); the `TenantMiddleware`
routes every query to the right DB. The branch-locality design adds zero
cross-tenant coupling — your code already correctly filters by tenant via
the routed DB, and adding `location_id` filters on top is purely
in-tenant.

### Deploy path covers both new and existing tenants

```bash
sudo bash /var/www/html/nsl-iffaa-application/deploy/deploy.sh
```

Inside `deploy.sh`:

1. `python manage.py migrate` — applies `accounting/0009_branch_locality`
   to the master DB (no-op for accounting tables; master holds users
   only).
2. `python manage.py migrate_tenants` — iterates every tenant DB and
   applies the same migration there. Tenants with existing accounts get
   `is_global = TRUE` and `location_id = NULL` by default (they all start
   as shared because nobody has set up branches yet); the CHECK
   constraint is satisfied. Existing journal lines get `location_id =
   NULL` and remain queryable; new entries posted via
   `post_balanced_entry` enforce the locality rule from this deploy
   forward.

### Backfilling legacy lines (optional, only if accurate per-branch
history matters)

```sql
-- Run per tenant DB. Picks "Main" as the default branch — adjust if
-- your tenant has a different primary location.
UPDATE journal_entry_lines jel
SET location_id = (
  SELECT id FROM locations WHERE LOWER(name) = 'main' LIMIT 1
)
WHERE jel.location_id IS NULL;
```

After this, ALTER the column to `NOT NULL` if you want the strict
contract everywhere — not done automatically because legacy data quality
varies between tenants and a forced NOT NULL would crash any tenant who
hasn't backfilled.

## 6. What `post_balanced_entry` enforces

```
post_balanced_entry(lines, location_id):
    if not location_id: raise JournalLocalityError("missing branch tag")
    for line in lines:
        a = line.account
        line_loc = line.location_id or location_id
        if not a.is_global and a.location_id != line_loc:
            raise JournalLocalityError(
                f"Account {a.code} locked to branch {a.location_id}; "
                f"got line from branch {line_loc}"
            )
    assert sum(debit) == sum(credit)
    persist
```

This single function is the chokepoint for every new ledger write. Every
service that creates journal entries — sales, purchases, expenses,
payments — should call it. (Existing service-layer writes still work
via direct `JournalEntryLine.objects.bulk_create`, but they bypass the
locality check; migrating each one is a follow-up sweep, not a blocker
for the new feature.)
