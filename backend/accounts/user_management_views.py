"""
Tenant-side User Management views.

NOTE on 500 errors when editing users
─────────────────────────────────────
If a PATCH /api/users/<id>/ ever surfaces a generic "Request failed with
status code 500", the cause is almost always one of:

  1. A pending migration. The model has columns the DB doesn't, e.g.
     ``tenant_role_id`` (added by 0015) or ``sales_commission_percent``
     (0014). Run `python manage.py migrate accounts` and recheck with
     `showmigrations accounts | tail`.
  2. A DB integrity error that escapes ValidationError — e.g. two users
     ending up with the same email/phone/username. The serializer below
     now turns those into clean 400 responses instead of 500s.



Endpoints (mounted under /api/accounts/users/):
  GET    /api/accounts/users/        — list users for the current tenant
  POST   /api/accounts/users/        — create a sub-user
  GET    /api/accounts/users/<id>/   — detail (only own tenant)
  PATCH  /api/accounts/users/<id>/   — update name / role / status / phone
  DELETE /api/accounts/users/<id>/   — soft-delete (sets is_active=False)

"Current tenant" = the requesting user's owner. For an Owner this is
themselves; for a sub-user it's their parent_owner. The list always
includes the owner so the table shows the same set of people the user
would expect to manage.

Only Owner / Admin roles may mutate users (POST / PATCH / DELETE).
"""
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.response import Response

from .models import TenantRole, User
from .permissions import has_permission


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _owner_id_for(user):
    """Tenant owner UUID for this user — themselves if they're an Owner,
    otherwise their parent_owner."""
    if user is None:
        return None
    if user.parent_owner_id:
        return user.parent_owner_id
    return user.id


def _integrity_message(exc) -> str:
    """Turn an IntegrityError into a clean user-facing message."""
    s = str(exc).lower()
    if "email" in s:
        return "A user with this email already exists."
    if "phone" in s:
        return "A user with this mobile number already exists."
    if "username" in s:
        return "A user with this username already exists."
    return "The save failed because it conflicts with another user record."


def _can_manage_users(user):
    """Owner / admin always; everyone else needs a granular user.* code."""
    if user.role in (User.Role.OWNER, User.Role.ADMIN):
        return True
    return any(
        has_permission(user, code)
        for code in ("user.add", "user.edit", "user.delete")
    )


def _can_view_users(user):
    if user.role in (User.Role.OWNER, User.Role.ADMIN, User.Role.MANAGER):
        return True
    return has_permission(user, "user.view")


def _can_view_roles(user):
    if user.role in (User.Role.OWNER, User.Role.ADMIN, User.Role.MANAGER):
        return True
    return has_permission(user, "role.view")


def _can_mutate_roles(user):
    if user.role in (User.Role.OWNER, User.Role.ADMIN):
        return True
    return any(
        has_permission(user, code)
        for code in ("role.add", "role.edit", "role.delete")
    )


# ──────────────────────────────────────────────────────────────────────────────
# Serializer
# ──────────────────────────────────────────────────────────────────────────────

class TenantUserSerializer(serializers.ModelSerializer):
    """Read + write serializer for tenant users."""

    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, min_length=6,
        help_text="Set on create. Leave blank to send a setup link separately.",
    )
    # Mobile is now the primary identifier — the tenant login form accepts
    # phone-or-email. Mark it required so the modal can't save without one.
    phone   = serializers.CharField(max_length=30, required=True, allow_blank=False)
    # Email is optional. The user model still has unique=True so it can't be
    # blank in the DB if set; we coerce empty strings to None on save.
    email   = serializers.EmailField(required=False, allow_blank=True)

    class Meta:
        model  = User
        fields = [
            "id", "username", "email", "name", "phone",
            "role", "status", "is_active",
            # Optional FK to a custom TenantRole granting granular perms.
            "tenant_role",
            # Branch this user belongs to (one of the tenant's locations).
            "branch_id", "branch_name",
            # New per-user sales settings (see model docstrings).
            "sales_commission_percent", "max_sales_discount_percent",
            "allow_selected_contacts", "allowed_contact_ids",
            "profile_picture", "created_at",
            "password",
        ]
        read_only_fields = ["id", "created_at", "profile_picture"]

    def validate_tenant_role(self, value):
        # Sub-users can only be assigned to a custom role owned by the
        # current tenant — never a role from a different tenant.
        if value is None:
            return None
        owner_id = self.context.get("owner_id")
        if owner_id and str(value.owner_id) != str(owner_id):
            raise serializers.ValidationError(
                "You can only assign roles that belong to this tenant."
            )
        return value

    def validate_email(self, value):
        # Email is optional. An empty / blank value is saved as NULL so
        # multiple "no-email" users don't collide on the unique index.
        if not value:
            return None
        v = value.strip().lower()
        qs = User.objects.filter(email__iexact=v)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this email already exists.")
        return v

    def validate_phone(self, value):
        v = (value or "").strip()
        if not v:
            raise serializers.ValidationError("Mobile number is required.")
        # Uniqueness check — phone now identifies the user at login, so
        # two accounts sharing one number would be ambiguous.
        qs = User.objects.filter(phone=v)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this mobile number already exists.")
        return v

    def validate_username(self, value):
        qs = User.objects.filter(username__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A user with this username already exists.")
        return value

    def validate_role(self, value):
        # Don't let anyone create another OWNER through this endpoint.
        if value == User.Role.OWNER and (
            self.instance is None or self.instance.role != User.Role.OWNER
        ):
            raise serializers.ValidationError(
                "Owner role can only be held by the tenant account holder."
            )
        return value

    def create(self, validated_data):
        from django.db import IntegrityError  # noqa: PLC0415
        password = validated_data.pop("password", "") or ""
        owner_id = self.context.get("owner_id")
        user = User(**validated_data)
        user.parent_owner_id = owner_id
        user.is_first_login  = bool(password)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        try:
            user.save()
        except IntegrityError as exc:
            raise serializers.ValidationError(_integrity_message(exc)) from exc
        return user

    def update(self, instance, validated_data):
        from django.db import IntegrityError  # noqa: PLC0415
        password = validated_data.pop("password", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        if password:
            instance.set_password(password)
        try:
            instance.save()
        except IntegrityError as exc:
            raise serializers.ValidationError(_integrity_message(exc)) from exc
        return instance


# ──────────────────────────────────────────────────────────────────────────────
# ViewSet
# ──────────────────────────────────────────────────────────────────────────────

@extend_schema_view(
    list=extend_schema(tags=["Users"], summary="List tenant users"),
    retrieve=extend_schema(tags=["Users"], summary="Get tenant user detail"),
    create=extend_schema(tags=["Users"], summary="Create a tenant sub-user"),
    update=extend_schema(tags=["Users"], summary="Update a tenant user"),
    partial_update=extend_schema(tags=["Users"], summary="Partial-update a tenant user"),
    destroy=extend_schema(tags=["Users"], summary="Soft-delete a tenant user"),
)
class TenantUserViewSet(viewsets.ModelViewSet):
    """CRUD for the User Management page in the tenant UI."""

    serializer_class   = TenantUserSerializer
    permission_classes = [permissions.IsAuthenticated]

    # All queries hit the master DB (User lives there).
    def get_queryset(self):
        from django.db.models import Q  # noqa: PLC0415
        owner_id = _owner_id_for(self.request.user)
        if not owner_id:
            return User.objects.none()
        # Use a Q() OR — NOT .union() — because DRF needs to call .get(pk=…)
        # against this queryset for retrieve / update / destroy, and
        # ".get() after .union()" is a Django NotSupportedError. Same
        # set as before: every user this owner parents, plus the owner.
        return (
            User.objects
            .filter(Q(parent_owner_id=owner_id) | Q(id=owner_id))
            .order_by("-created_at")
        )

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["owner_id"] = _owner_id_for(self.request.user)
        return ctx

    # ── Per-action permission checks ─────────────────────────────────────
    # Each verb maps to a granular code from role.txt (user.view / add /
    # edit / delete). Owner / admin always pass; everyone else has to
    # hold the right code on their built-in OR custom TenantRole.

    def list(self, request, *args, **kwargs):
        if not _can_view_users(request.user):
            return Response({"detail": "You need the 'View user' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):
        if not _can_view_users(request.user):
            return Response({"detail": "You need the 'View user' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().retrieve(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "user.add"):
            return Response({"detail": "You need the 'Add user' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "user.edit"):
            return Response({"detail": "You need the 'Edit user' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        instance = self.get_object()
        # Sub-users may never escalate themselves to a higher role here —
        # we already block OWNER above in the serializer.
        if instance.role == User.Role.OWNER and instance.id != request.user.id:
            return Response({"detail": "The tenant owner cannot be modified through this endpoint."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "user.delete"):
            return Response({"detail": "You need the 'Delete user' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        instance = self.get_object()
        if instance.role == User.Role.OWNER:
            return Response({"detail": "The tenant owner cannot be deleted."},
                            status=status.HTTP_403_FORBIDDEN)
        if instance.id == request.user.id:
            return Response({"detail": "You cannot delete your own account here."},
                            status=status.HTTP_403_FORBIDDEN)
        instance.is_active = False
        instance.status    = User.Status.SUSPENDED
        instance.save(update_fields=["is_active", "status"])
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# Roles — Built-in catalog + custom per-tenant labels
# ──────────────────────────────────────────────────────────────────────────────

# Built-in roles are rendered virtually (no DB rows) and cannot be edited
# or deleted. The codes match User.Role.choices so the UI can show role
# usage counts in the future without juggling two namespaces.
BUILTIN_ROLES = [
    {"code": "admin",   "name": "Admin",   "description": "Full access; can manage users, settings and reports.", "is_system": True},
    {"code": "manager", "name": "Manager", "description": "Can apply discounts and view reports; no settings.",   "is_system": True},
    {"code": "cashier", "name": "Cashier", "description": "POS access only; discounts need supervisor approval.", "is_system": True},
]


class TenantRoleSerializer(serializers.ModelSerializer):
    code       = serializers.SerializerMethodField()
    is_system  = serializers.SerializerMethodField()

    class Meta:
        model  = TenantRole
        fields = [
            "id", "code", "name", "description", "permissions",
            "is_system", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "code", "is_system", "created_at", "updated_at"]

    def validate_permissions(self, value):
        # Defensive: accept only a list of non-empty strings; dedupe.
        if value is None: return []
        if not isinstance(value, list):
            raise serializers.ValidationError("permissions must be a list of permission codes.")
        out, seen = [], set()
        for code in value:
            s = str(code or "").strip()
            if s and s not in seen:
                out.append(s); seen.add(s)
        return out

    def get_code(self, obj):
        # Custom roles use their UUID as the code; lower-cased name keeps it readable in lists.
        return f"custom:{obj.name.lower().replace(' ', '_')}"

    def get_is_system(self, _obj):
        return False

    def validate_name(self, value):
        v = (value or "").strip()
        if not v:
            raise serializers.ValidationError("Role name is required.")
        if v.lower() in {r["name"].lower() for r in BUILTIN_ROLES}:
            raise serializers.ValidationError(
                f"'{v}' is a built-in role and cannot be redefined."
            )
        owner_id = self.context.get("owner_id")
        qs = TenantRole.objects.filter(owner_id=owner_id, name__iexact=v)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError("A role with this name already exists.")
        return v

    def create(self, validated_data):
        validated_data["owner_id"] = self.context["owner_id"]
        return super().create(validated_data)


@extend_schema_view(
    list=extend_schema(tags=["Users"], summary="List roles (built-ins + custom)"),
    retrieve=extend_schema(tags=["Users"], summary="Get role detail"),
    create=extend_schema(tags=["Users"], summary="Create a custom role"),
    update=extend_schema(tags=["Users"], summary="Update a custom role"),
    partial_update=extend_schema(tags=["Users"], summary="Partial-update a custom role"),
    destroy=extend_schema(tags=["Users"], summary="Delete a custom role"),
)
class TenantRoleViewSet(viewsets.ModelViewSet):
    """
    Tenant-scoped role catalog. The list endpoint merges the built-in
    Admin / Manager / Cashier triplet with the tenant's own custom rows
    so the UI can render one combined table with the system roles
    flagged read-only.
    """
    serializer_class   = TenantRoleSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        owner_id = _owner_id_for(self.request.user)
        if not owner_id:
            return TenantRole.objects.none()
        return TenantRole.objects.filter(owner_id=owner_id).order_by("name")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["owner_id"] = _owner_id_for(self.request.user)
        return ctx

    def list(self, request, *args, **kwargs):
        # Custom roles first, then built-ins (flagged is_system).
        custom = self.get_serializer(self.get_queryset(), many=True).data
        system = [
            {"id": f"system:{r['code']}", **r, "created_at": None, "updated_at": None}
            for r in BUILTIN_ROLES
        ]
        return Response(system + custom)

    def list(self, request, *args, **kwargs):
        # Allow anyone with role.view or the broader manage-users
        # permission to see the role list. Existing tenants whose
        # built-in role naturally has access keep it.
        if not _can_view_roles(request.user):
            return Response({"detail": "You need the 'View role' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().list(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "role.add"):
            return Response({"detail": "You need the 'Add role' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "role.edit"):
            return Response({"detail": "You need the 'Edit role' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        if request.user.role not in (User.Role.OWNER, User.Role.ADMIN) \
                and not has_permission(request.user, "role.delete"):
            return Response({"detail": "You need the 'Delete role' permission."},
                            status=status.HTTP_403_FORBIDDEN)
        return super().destroy(request, *args, **kwargs)

