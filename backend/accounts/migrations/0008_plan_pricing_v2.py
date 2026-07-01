"""
Plan model v2 — adds billing_cycle, trial, custom, per-branch fee, features
and seeds the production plan catalogue:

  • Free Trial           — 14 days, ৳0
  • Basic    (monthly)   — ৳300  / 1 branch  / 10 sub-accounts
  • Basic    (yearly)    — ৳2,880 (~20% off) / 1 branch
  • Standard (monthly)   — ৳500  / 2 branches / 10 sub-accounts  [popular]
  • Standard (yearly)    — ৳4,800
  • Premium  (monthly)   — ৳700  / 4 branches / 10 sub-accounts
  • Premium  (yearly)    — ৳6,720
  • Multi-Branch         — ৳300 base + ৳200/branch (custom)
"""
from decimal import Decimal
from django.db import migrations, models


# Canonical seed catalogue — order matches sort_order.
PLAN_SEED = [
    {
        "code": "free-trial", "name": "Free Trial",
        "price": Decimal("0"), "billing_cycle": "monthly", "duration_days": 14,
        "is_trial": True, "is_custom": False,
        "max_branches": 1, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "Full feature access for 14 days. After trial, account is paused until you pick a plan.",
        "features": [
            "Full access to all features for 14 days",
            "Unlimited test transactions",
            "Up to 10 sub-accounts during trial",
            "After trial: account disabled, billing visible only",
            "No credit card required",
        ],
        "sort_order": 10,
    },
    {
        "code": "basic-monthly", "name": "Basic",
        "price": Decimal("300"), "billing_cycle": "monthly", "duration_days": 30,
        "is_trial": False, "is_custom": False,
        "max_branches": 1, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "Single branch, 10 sub-accounts. Everything you need to run one outlet.",
        "features": [
            "1 Business location",
            "Up to 10 sub-accounts",
            "POS, Invoicing & Expenses",
            "Inventory & Stock Transfer",
            "Full reports (P&L, Sales, Stock)",
            "Email support",
        ],
        "sort_order": 20,
    },
    {
        "code": "basic-yearly", "name": "Basic (Yearly)",
        "price": Decimal("2880"), "billing_cycle": "yearly", "duration_days": 365,
        "is_trial": False, "is_custom": False,
        "max_branches": 1, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "Yearly Basic — save 20% vs paying monthly.",
        "features": [
            "Everything in Basic",
            "20% yearly discount (regular ৳3,600)",
            "Locked-in pricing for 12 months",
        ],
        "sort_order": 21,
    },
    {
        "code": "standard-monthly", "name": "Standard",
        "price": Decimal("500"), "billing_cycle": "monthly", "duration_days": 30,
        "is_trial": False, "is_custom": False,
        "max_branches": 2, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "2 branches, 10 sub-accounts with enhanced limits and priority support.",
        "features": [
            "Up to 2 Business locations",
            "Up to 10 sub-accounts",
            "Everything in Basic",
            "Customer groups & loyalty",
            "Tax compliance reports",
            "Priority email support",
        ],
        "sort_order": 30,
    },
    {
        "code": "standard-yearly", "name": "Standard (Yearly)",
        "price": Decimal("4800"), "billing_cycle": "yearly", "duration_days": 365,
        "is_trial": False, "is_custom": False,
        "max_branches": 2, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "Yearly Standard — save 20% vs paying monthly.",
        "features": [
            "Everything in Standard",
            "20% yearly discount (regular ৳6,000)",
            "Locked-in pricing for 12 months",
        ],
        "sort_order": 31,
    },
    {
        "code": "premium-monthly", "name": "Premium",
        "price": Decimal("700"), "billing_cycle": "monthly", "duration_days": 30,
        "is_trial": False, "is_custom": False,
        "max_branches": 4, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "4 branches, 10 sub-accounts with our full feature set.",
        "features": [
            "Up to 4 Business locations",
            "Up to 10 sub-accounts",
            "Everything in Standard",
            "Advanced analytics & forecasting",
            "API access & webhooks",
            "Dedicated chat support",
        ],
        "sort_order": 40,
    },
    {
        "code": "premium-yearly", "name": "Premium (Yearly)",
        "price": Decimal("6720"), "billing_cycle": "yearly", "duration_days": 365,
        "is_trial": False, "is_custom": False,
        "max_branches": 4, "max_sub_accounts": 10, "per_branch_fee": Decimal("0"),
        "description": "Yearly Premium — save 20% vs paying monthly.",
        "features": [
            "Everything in Premium",
            "20% yearly discount (regular ৳8,400)",
            "Locked-in pricing for 12 months",
        ],
        "sort_order": 41,
    },
    {
        "code": "multi-branch", "name": "Multi-Branch",
        "price": Decimal("300"), "billing_cycle": "monthly", "duration_days": 30,
        "is_trial": False, "is_custom": True,
        "max_branches": 0,           # unlimited (validated by extra_branches input)
        "max_sub_accounts": 10,
        "per_branch_fee": Decimal("200"),
        "description": "Built on Basic — add as many branches as you need at ৳200/branch/month.",
        "features": [
            "Built on Basic plan (৳300/mo)",
            "Add branches: ৳200 / branch / month",
            "Up to 10 sub-accounts per branch",
            "Centralised reporting across branches",
            "Inter-branch stock transfer",
            "Priority support",
        ],
        "sort_order": 50,
    },
]


def seed_plans(apps, schema_editor):
    Plan = apps.get_model("accounts", "Plan")

    # Deactivate any legacy plans whose code we're not seeding — they shouldn't
    # appear on the public page, but we keep the rows so existing subscriptions
    # still resolve (PROTECT FK).
    Plan.objects.filter(code__isnull=True).update(is_active=False)

    for entry in PLAN_SEED:
        Plan.objects.update_or_create(
            code=entry["code"],
            defaults={
                "name":             entry["name"],
                "price":            entry["price"],
                "billing_cycle":    entry["billing_cycle"],
                "duration_days":    entry["duration_days"],
                "description":      entry["description"],
                "is_active":        True,
                "is_trial":         entry["is_trial"],
                "is_custom":        entry["is_custom"],
                "max_branches":     entry["max_branches"],
                "max_sub_accounts": entry["max_sub_accounts"],
                "per_branch_fee":   entry["per_branch_fee"],
                "features":         entry["features"],
                "sort_order":       entry["sort_order"],
            },
        )


def unseed_plans(apps, schema_editor):
    Plan = apps.get_model("accounts", "Plan")
    Plan.objects.filter(code__in=[e["code"] for e in PLAN_SEED]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0007_plan_max_branches"),
    ]

    operations = [
        migrations.AddField(
            model_name="plan",
            name="code",
            field=models.SlugField(max_length=64, null=True, blank=True, unique=True),
        ),
        migrations.AddField(
            model_name="plan",
            name="billing_cycle",
            field=models.CharField(
                max_length=10,
                choices=[("monthly", "Monthly"), ("yearly", "Yearly")],
                default="monthly",
                db_index=True,
            ),
        ),
        migrations.AddField(
            model_name="plan",
            name="is_trial",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="plan",
            name="is_custom",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="plan",
            name="max_sub_accounts",
            field=models.PositiveIntegerField(default=10),
        ),
        migrations.AddField(
            model_name="plan",
            name="per_branch_fee",
            field=models.DecimalField(max_digits=10, decimal_places=2, default=0),
        ),
        migrations.AddField(
            model_name="plan",
            name="features",
            field=models.JSONField(default=list, blank=True),
        ),
        migrations.AddField(
            model_name="plan",
            name="sort_order",
            field=models.PositiveIntegerField(default=100, db_index=True),
        ),
        migrations.AlterModelOptions(
            name="plan",
            options={"ordering": ["sort_order", "price"]},
        ),
        migrations.RunPython(seed_plans, reverse_code=unseed_plans),
    ]
