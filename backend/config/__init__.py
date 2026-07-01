# Import the Celery app so it is always loaded when Django starts,
# ensuring @shared_task decorators work correctly.
from .celery import app as celery_app

__all__ = ["celery_app"]
