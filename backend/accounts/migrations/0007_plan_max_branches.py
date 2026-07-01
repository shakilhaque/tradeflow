from django.db import migrations, models


def seed_branch_limits(apps, schema_editor):
    Plan = apps.get_model("accounts", "Plan")
    # Heuristic seed by price tier: cheapest=1, mid=3, top=unlimited.
    plans = list(Plan.objects.order_by("price"))
    if not plans:
        return
    if len(plans) == 1:
        plans[0].max_branches = 1
        plans[0].save(update_fields=["max_branches"])
        return
    tiers = [1, 3, 10, 0]  # last tier = unlimited
    for i, plan in enumerate(plans):
        plan.max_branches = tiers[min(i, len(tiers) - 1)]
        plan.save(update_fields=["max_branches"])


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0006_alter_permission_id_alter_rolepermission_id_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="plan",
            name="max_branches",
            field=models.PositiveIntegerField(
                default=1,
                help_text="Maximum active business locations allowed. 0 = unlimited.",
            ),
        ),
        migrations.RunPython(seed_branch_limits, reverse_code=migrations.RunPython.noop),
    ]
