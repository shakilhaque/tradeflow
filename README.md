# NSL-POS

Single-client point-of-sale, inventory and accounting system.

- **Backend** — Django 4.2 + DRF + PostgreSQL (single database)
- **Frontend** — React 18 + Vite 5 + Tailwind CSS 3
- **Auth** — JWT (SimpleJWT), email + password login

> This is a single-tenant build: no SaaS onboarding, no subscriptions, no
> OTP, no public marketing site. One business, one database, staff users with
> role-based permissions, and optional multi-branch support.

---

## Prerequisites

| Tool       | Version   |
|------------|-----------|
| Python     | 3.11+     |
| Node.js    | 18 or 20  |
| PostgreSQL | 14+       |

---

## First-time setup

### 1. Create the database

```bash
psql -U postgres -c "CREATE DATABASE nsl_pos"
```

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1        # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt

# Copy env template and edit DATABASE_URL / SECRET_KEY
copy ..\.env.example .env          # Windows  (macOS/Linux: cp ../.env.example .env)

python manage.py migrate
python manage.py runserver 8003
```

Backend serves at <http://127.0.0.1:8003>.

Create the first login (owner):

```bash
python manage.py shell -c "from accounts.models import User; User.objects.create_user(email='owner@nslpos.com', name='Owner', password='Owner@1234', role='owner', is_active=True, is_staff=True, is_superuser=True, is_first_login=False)"
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev -- --port 3050
```

Frontend serves at <http://localhost:3050> and proxies `/api/*` to port 8003.
Sign in at <http://localhost:3050/login> with the owner email + password above.

---

## Project layout

```
.
├── backend/                # Django backend (run manage.py commands here)
│   ├── accounts/           # Users, roles, permissions, branches, auth
│   ├── accounting/         # Journal, accounts, expenses
│   ├── audit/              # Audit log
│   ├── config/             # Django project settings
│   ├── core/               # Shared response envelope + utilities
│   ├── imports/            # CSV/XLSX import
│   ├── inventory/          # Products, stock, FIFO, movements
│   ├── notifications/      # In-app notifications
│   ├── purchases/          # Purchases + returns
│   ├── reports/            # Sales / stock / expense / tax reports
│   ├── sales/              # Sales, customers, POS, returns, discounts
│   └── system_config/      # Settings, tax groups
├── frontend/               # React + Vite UI
└── README.md
```
