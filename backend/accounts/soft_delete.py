"""
Soft-delete mixin for tenant-DB models.

Usage
─────
  from accounts.soft_delete import SoftDeleteMixin

  class Product(SoftDeleteMixin, models.Model):
      ...

SoftDeleteManager (default `objects`) hides soft-deleted rows.
AllObjectsManager (`all_objects`) exposes everything including deleted rows.

  # Normal queries — deleted rows invisible
  Product.objects.all()

  # Include deleted rows
  Product.all_objects.all()

  # Soft-delete
  product.delete()                 → sets is_deleted=True, deleted_at=now

  # Hard (physical) delete when truly needed
  product.hard_delete()

  # Restore
  product.restore()
"""
from django.db import models
from django.utils import timezone


# ──────────────────────────────────────────────────────────────────────────────
# Managers
# ──────────────────────────────────────────────────────────────────────────────

class SoftDeleteQuerySet(models.QuerySet):
    """QuerySet that adds delete() / restore() batch support."""

    def delete(self):
        """Soft-delete all rows in this queryset."""
        return self.update(is_deleted=True, deleted_at=timezone.now())

    def hard_delete(self):
        """Physically delete all rows in this queryset."""
        return super().delete()

    def restore(self):
        """Un-delete all soft-deleted rows in this queryset."""
        return self.update(is_deleted=False, deleted_at=None)


class SoftDeleteManager(models.Manager):
    """
    Default manager — automatically hides soft-deleted rows.

    Use `Model.all_objects` to include deleted rows.
    """

    def get_queryset(self):
        return SoftDeleteQuerySet(self.model, using=self._db).filter(is_deleted=False)

    def deleted(self):
        """Return only soft-deleted rows."""
        return SoftDeleteQuerySet(self.model, using=self._db).filter(is_deleted=True)


class AllObjectsManager(models.Manager):
    """Manager that returns ALL rows, including soft-deleted ones."""

    def get_queryset(self):
        return SoftDeleteQuerySet(self.model, using=self._db)


# ──────────────────────────────────────────────────────────────────────────────
# Abstract mixin model
# ──────────────────────────────────────────────────────────────────────────────

class SoftDeleteMixin(models.Model):
    """
    Abstract mixin that adds soft-delete behaviour to a model.

    Fields added
    ────────────
    is_deleted  BooleanField(default=False) — True when the row is deleted.
    deleted_at  DateTimeField(null=True)    — timestamp of soft-delete.
    """

    is_deleted = models.BooleanField(default=False, db_index=True, editable=False)
    deleted_at = models.DateTimeField(null=True, blank=True, editable=False)

    objects     = SoftDeleteManager()
    all_objects = AllObjectsManager()

    class Meta:
        abstract = True

    # ── Instance-level operations ─────────────────────────────────────────────

    def delete(self, using=None, keep_parents=False):
        """
        Soft-delete: mark is_deleted=True and stamp deleted_at.
        Does NOT call super().delete() — the row stays in the DB.
        """
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.save(using=using, update_fields=["is_deleted", "deleted_at"])

    def hard_delete(self, using=None, keep_parents=False):
        """Physical delete — permanently removes the row."""
        super().delete(using=using, keep_parents=keep_parents)

    def restore(self):
        """Undo a soft-delete."""
        self.is_deleted = False
        self.deleted_at = None
        self.save(update_fields=["is_deleted", "deleted_at"])
