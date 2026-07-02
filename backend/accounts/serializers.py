"""
Auth serializers for the single-client build — JWT login only.
"""
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .permissions import get_user_permissions


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Embed role / name / email / permissions in the access token so the
    frontend can gate UI without an extra profile call."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"]            = user.role
        token["name"]            = user.name
        token["email"]           = user.email
        token["profile_picture"] = getattr(user, "profile_picture", "") or ""
        token["permissions"]     = sorted(get_user_permissions(user))
        return token


class LoginSerializer(serializers.Serializer):
    """Email (or username / mobile) + password → JWT access & refresh pair."""

    email      = serializers.EmailField(required=False, allow_blank=True)
    identifier = serializers.CharField(required=False, allow_blank=True, max_length=150)
    username   = serializers.CharField(required=False, allow_blank=True, max_length=80)
    password   = serializers.CharField(write_only=True, style={"input_type": "password"})

    def validate(self, attrs):
        from .models import User

        password = attrs["password"]
        raw = (attrs.get("email") or attrs.get("identifier") or attrs.get("username") or "").strip()
        if not raw:
            raise serializers.ValidationError("Enter your email and password.")

        user = None
        if "@" in raw:
            user = User.objects.filter(email__iexact=raw.lower()).first()
        else:
            user = User.objects.filter(username__iexact=raw).first()
            if user is None:
                digits = "".join(c for c in raw if c.isdigit())
                if len(digits) >= 6:
                    user = (
                        User.objects.filter(phone__icontains=digits[-9:])
                        .order_by("created_at")
                        .first()
                    )

        if user is None or not user.check_password(password):
            raise serializers.ValidationError({"detail": "Invalid email or password."})
        if getattr(user, "is_locked", False):
            raise serializers.ValidationError(
                {"detail": "This account is locked. Contact an administrator."}
            )

        refresh = CustomTokenObtainPairSerializer.get_token(user)
        permissions = sorted(get_user_permissions(user))
        profile = {
            "id":              str(user.id),
            "email":           user.email,
            "name":            user.name,
            "username":        user.username,
            "status":          user.status,
            "role":            user.role,
            "is_staff":        user.is_staff,
            "is_superuser":    user.is_superuser,
            "profile_picture": getattr(user, "profile_picture", "") or "",
            "permissions":     permissions,
        }
        return {
            "access":  str(refresh.access_token),
            "refresh": str(refresh),
            "user_id": str(user.id),
            **{k: profile[k] for k in ("email", "name", "role", "status",
                                        "is_staff", "is_superuser", "profile_picture", "permissions")},
            "user": profile,
        }
