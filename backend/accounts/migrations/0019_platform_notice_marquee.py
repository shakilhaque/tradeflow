"""Add is_marquee + marquee_speed to PlatformNotice.

Idempotent SQL via SeparateDatabaseAndState — adds the column with
`ADD COLUMN IF NOT EXISTS` so re-applying on a hand-fixed DB is a
no-op. Pairs with the existing pattern used elsewhere (see
purchases/0003_supplier_soft_delete.py).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0018_platform_notice"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name="platformnotice",
                    name="is_marquee",
                    field=models.BooleanField(
                        default=False, db_index=True,
                        help_text=(
                            "Render as a right-to-left scrolling marquee on every tenant "
                            "page. Only the newest is_marquee=True notice is shown."
                        ),
                    ),
                ),
                migrations.AddField(
                    model_name="platformnotice",
                    name="marquee_speed",
                    field=models.PositiveSmallIntegerField(
                        default=40,
                        help_text=(
                            "Marquee scroll duration in seconds (lower = faster). 40 is a "
                            "comfortable reading pace; 20 is fast, 80 is slow."
                        ),
                    ),
                ),
            ],
            database_operations=[
                migrations.RunSQL(
                    sql=[
                        'ALTER TABLE "platform_notices" '
                        'ADD COLUMN IF NOT EXISTS "is_marquee" boolean NOT NULL DEFAULT false;',
                        'CREATE INDEX IF NOT EXISTS '
                        '"platform_notices_is_marquee_idx" '
                        'ON "platform_notices" ("is_marquee");',
                        'ALTER TABLE "platform_notices" '
                        'ADD COLUMN IF NOT EXISTS "marquee_speed" smallint NOT NULL DEFAULT 40;',
                    ],
                    reverse_sql=[
                        'DROP INDEX IF EXISTS "platform_notices_is_marquee_idx";',
                        'ALTER TABLE "platform_notices" DROP COLUMN IF EXISTS "marquee_speed";',
                        'ALTER TABLE "platform_notices" DROP COLUMN IF EXISTS "is_marquee";',
                    ],
                ),
            ],
        ),
    ]
