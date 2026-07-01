"""Add postal-address fields to User.

Collected from the Subscribe / TrialSignup checkout form and surfaced
on the new admin "Client's Info" page. All four columns are nullable
in the model definition (blank=True) so existing rows backfill as
empty strings rather than requiring a data-migration step.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0016_user_email_nullable"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="address",
            field=models.CharField(blank=True, max_length=255,
                                   help_text="Street address / building / area."),
        ),
        migrations.AddField(
            model_name="user",
            name="thana",
            field=models.CharField(blank=True, max_length=120,
                                   help_text="Thana / upazila / sub-district."),
        ),
        migrations.AddField(
            model_name="user",
            name="district",
            field=models.CharField(blank=True, max_length=120,
                                   help_text="District (Zila)."),
        ),
        migrations.AddField(
            model_name="user",
            name="postal_code",
            field=models.CharField(blank=True, max_length=20,
                                   help_text="Bangladesh postal code (e.g. 1207)."),
        ),
    ]
