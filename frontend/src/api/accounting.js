import { client, apiCall } from './client'

// ── Chart of Accounts ─────────────────────────────────────────────────────────

export const getAccounts = (params = {}) =>
  apiCall(() => client.get('/api/accounting/accounts/', { params }))

export const createAccount = (data) =>
  apiCall(() => client.post('/api/accounting/accounts/', data))

export const updateAccount = (id, data) =>
  apiCall(() => client.patch(`/api/accounting/accounts/${id}/`, data))

// ── Journal Entries ───────────────────────────────────────────────────────────

/** params: { date_from, date_to, limit } */
export const getJournalEntries = (params = {}) =>
  apiCall(() => client.get('/api/accounting/journal-entries/', { params }))

/** Manual JE: { description, date, lines:[{account_id, debit, credit, description}] } */
export const createJournalEntry = (data) =>
  apiCall(() => client.post('/api/accounting/journal-entries/', data))

// ── Expenses ──────────────────────────────────────────────────────────────────

/** params: { date_from, date_to, category, limit } */
export const getExpenses = (params = {}) =>
  apiCall(() => client.get('/api/accounting/expenses/', { params }))

/** { category, amount, expense_account_id, payment_account_id, description, expense_date } */
export const createExpense = (data) =>
  apiCall(() => client.post('/api/accounting/expenses/', data))

export const updateExpense = (id, data) =>
  apiCall(() => client.patch(`/api/accounting/expenses/${id}/`, data))

export const deleteExpense = (id) =>
  apiCall(() => client.delete(`/api/accounting/expenses/${id}/`))

// Expense detail (fetches embedded payments + every editable field).
export const getExpense = (id) =>
  apiCall(() => client.get(`/api/accounting/expenses/${id}/`))

// Expense Payments — same CRUD shape as PurchaseReturnPayments. The
// backend handles PaymentAccount ledger reversal on edit + delete.
export const getExpensePayments = (id) =>
  apiCall(() => client.get(`/api/accounting/expenses/${id}/payments/`))

export const addExpensePayment = (id, data) =>
  apiCall(() => client.post(`/api/accounting/expenses/${id}/payments/`, data))

export const updateExpensePayment = (paymentId, data) =>
  apiCall(() => client.patch(`/api/accounting/expenses/payments/${paymentId}/`, data))

export const deleteExpensePayment = (paymentId) =>
  apiCall(() => client.delete(`/api/accounting/expenses/payments/${paymentId}/`))

// ── Expense Categories (master data) ─────────────────────────────────────────

export const getExpenseCategories = (params = {}) =>
  apiCall(() => client.get('/api/accounting/expense-categories/', { params }))

export const createExpenseCategory = (data) =>
  apiCall(() => client.post('/api/accounting/expense-categories/', data))

export const updateExpenseCategory = (id, data) =>
  apiCall(() => client.patch(`/api/accounting/expense-categories/${id}/`, data))

export const deleteExpenseCategory = (id) =>
  apiCall(() => client.delete(`/api/accounting/expense-categories/${id}/`))

// ── Payment Accounts (Cash / Bank / MFS wallets) ─────────────────────────────

export const getPaymentAccounts = (params = {}) =>
  apiCall(() => client.get('/api/accounting/payment-accounts/', { params }))

export const createPaymentAccount = (data) =>
  apiCall(() => client.post('/api/accounting/payment-accounts/', data))

export const updatePaymentAccount = (id, data) =>
  apiCall(() => client.patch(`/api/accounting/payment-accounts/${id}/`, data))

export const deletePaymentAccount = (id) =>
  apiCall(() => client.delete(`/api/accounting/payment-accounts/${id}/`))

/** Merchant-view balance summary: customer due, supplier due, closing stock, accounts. */
export const getBalanceSummary = (params = {}) =>
  apiCall(() => client.get('/api/accounting/balance-summary/', { params }))

// ── Payment Account transactions (Account Book / Deposit / Transfer) ────────

/** Ledger of a single payment account. */
export const getPaymentAccountTransactions = (id, params = {}) =>
  apiCall(() => client.get(`/api/accounting/payment-accounts/${id}/transactions/`, { params }))

/** Record a deposit / withdrawal / adjustment for one account. */
export const depositToPaymentAccount = (id, data) =>
  apiCall(() => client.post(`/api/accounting/payment-accounts/${id}/deposit/`, data))

/** Move money from one payment account to another (creates both ledger legs). */
export const transferBetweenPaymentAccounts = (data) =>
  apiCall(() => client.post('/api/accounting/payment-account-transfers/', data))

/** Unified cash flow ledger (sales / purchases / expenses / manual txns). */
export const getCashFlowLedger = (params = {}) =>
  apiCall(() => client.get('/api/accounting/cash-flow-ledger/', { params }))

/** Payment account report — list payments + their linked account. */
export const getPaymentAccountReport = (params = {}) =>
  apiCall(() => client.get('/api/accounting/payment-account-report/', { params }))

/** Link a payment reference to a payment account. */
export const linkPaymentToAccount = (data) =>
  apiCall(() => client.post('/api/accounting/payment-account-report/link/', data))

// ── Profit / Loss merchant report ────────────────────────────────────────────

export const getProfitLossSummary = (params = {}) =>
  apiCall(() => client.get('/api/accounting/profit-loss-summary/', { params }))

export const getProfitLossBreakdown = (params = {}) =>
  apiCall(() => client.get('/api/accounting/profit-loss-breakdown/', { params }))

// ── Accounting Reports ────────────────────────────────────────────────────────

export const getTrialBalance = (params = {}) =>
  apiCall(() => client.get('/api/accounting/trial-balance/', { params }))

export const getProfitLoss = (params = {}) =>
  apiCall(() => client.get('/api/accounting/profit-loss/', { params }))

export const getBalanceSheet = (params = {}) =>
  apiCall(() => client.get('/api/accounting/balance-sheet/', { params }))

export const getLedger = (params = {}) =>
  apiCall(() => client.get('/api/accounting/ledger/', { params }))
