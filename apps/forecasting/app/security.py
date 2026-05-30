from fastapi import Header, HTTPException
from .config import UserScope, settings


def require_internal_user(
    x_internal_service_token: str = Header(default=""),
    x_user_id: str = Header(default=""),
    x_user_role: str = Header(default=""),
    x_user_shop_id: str = Header(default=""),
) -> UserScope:
    if x_internal_service_token != settings.internal_service_token:
        raise HTTPException(status_code=401, detail="Invalid internal service token")
    try:
        user_id = int(x_user_id)
    except ValueError:
        raise HTTPException(status_code=401, detail="Missing user identity") from None
    role = x_user_role.upper()
    shop_id = int(x_user_shop_id) if x_user_shop_id else None
    if role not in {"OWNER", "STAFF"}:
        raise HTTPException(status_code=403, detail="Invalid role")
    if role != "OWNER" and shop_id is None:
        raise HTTPException(status_code=403, detail="Staff user requires shop scope")
    return UserScope(user_id=user_id, role=role, shop_id=shop_id)
