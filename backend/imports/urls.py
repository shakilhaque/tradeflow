from django.urls import path
from . import views

app_name = "imports"

urlpatterns = [
    # List own batches
    path("", views.ImportBatchListView.as_view(), name="batch-list"),

    # Per-type template download + validate
    path("<str:import_type>/template/", views.ImportTemplateView.as_view(), name="template"),
    path("<str:import_type>/analyze/",  views.ImportAnalyzeView.as_view(),  name="analyze"),
    path("<str:import_type>/validate/", views.ImportValidateView.as_view(), name="validate"),

    # Per-batch commit + detail
    path("<uuid:batch_id>/", views.ImportBatchDetailView.as_view(), name="batch-detail"),
    path("<uuid:batch_id>/commit/", views.ImportCommitView.as_view(), name="commit"),
]
