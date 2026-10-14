locals {
  web_service_name    = "rulebranch-web"
  worker_service_name = "rulebranch-worker"

  required_apis = [
    "firestore.googleapis.com",
    "run.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
  ]
}

data "google_project" "current" {
  project_id = var.project_id
}

# Best-effort API enablement for a fresh project. Terraform cannot express "wait until
# this API is fully propagated" as a dependency on every downstream resource, so a first
# `apply` on a brand-new project may still need a second `apply` if a resource races ahead
# of its API becoming active.
resource "google_project_service" "required" {
  for_each           = toset(local.required_apis)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.required]
}

# Review queue queries scope proposed versions to a workspace and order them by
# creation time. Firestore requires this composite index for that query shape.
resource "google_firestore_index" "rule_versions_by_workspace_status_created_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "rule_versions"

  fields {
    field_path = "ownerWorkspaceId"
    order      = "ASCENDING"
  }

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "ASCENDING"
  }
}

# Project detail pages list a workspace's analysis jobs for one project in
# newest-first order. Firestore requires this composite index for that shape.
resource "google_firestore_index" "analysis_jobs_by_workspace_project_created_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "analysis_jobs"

  fields {
    field_path = "ownerWorkspaceId"
    order      = "ASCENDING"
  }

  fields {
    field_path = "projectId"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

# Workspace overview reads each project's latest bootstrap job independently
# of newer drift or publication jobs.
resource "google_firestore_index" "analysis_jobs_by_workspace_project_type_created_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "analysis_jobs"

  fields {
    field_path = "ownerWorkspaceId"
    order      = "ASCENDING"
  }

  fields {
    field_path = "projectId"
    order      = "ASCENDING"
  }

  fields {
    field_path = "type"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

resource "google_service_account" "web" {
  account_id   = "rulebranch-web"
  display_name = "RuleBranch Web Cloud Run"
}

resource "google_service_account" "worker" {
  account_id   = "rulebranch-worker"
  display_name = "RuleBranch Worker Cloud Run"
}

resource "google_service_account" "scheduler" {
  account_id   = "rulebranch-scheduler"
  display_name = "RuleBranch Cloud Scheduler"
}

# Cloud Scheduler's own service agent must be allowed to mint OIDC tokens as the
# rulebranch-scheduler service account in order to attach oidc_token to its jobs below.
resource "google_service_account_iam_member" "scheduler_agent_can_impersonate" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret" "github_app_private_key" {
  secret_id = "rulebranch-github-app-private-key"
  # HCL's single-line block syntax only permits attribute assignments, not a
  # nested block like auto{} — `replication { auto {} }` fails
  # terraform init/validate with "A single-line block definition can contain
  # only a single argument". Must be written multi-line.
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "webhook_secret" {
  secret_id = "rulebranch-webhook-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "ai_api_key" {
  secret_id = "rulebranch-ai-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "github_oauth_client_secret" {
  secret_id = "rulebranch-github-oauth-client-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "session_secret" {
  secret_id = "rulebranch-session-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "demo_login_password" {
  count     = var.demo_login_enabled ? 1 : 0
  secret_id = "rulebranch-demo-login-password"
  replication {
    auto {}
  }
}

# The private approval evaluator runs the Web image but is not a browser session
# issuer. Give it an independent key so compromise of that service cannot mint
# cookies accepted by the public Web service.
resource "google_secret_manager_secret" "approval_session_secret" {
  secret_id = "rulebranch-approval-session-secret"
  replication {
    auto {}
  }
}

# Secret payloads deliberately are not Terraform resources: inject a version
# for each secret manually or from CI/CD, so secret values never enter state.
resource "google_secret_manager_secret_iam_member" "worker_github_app_private_key" {
  secret_id = google_secret_manager_secret.github_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_ai_api_key" {
  secret_id = google_secret_manager_secret.ai_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# The web service consumes these existing GitHub secrets as Cloud Run env vars.
resource "google_secret_manager_secret_iam_member" "web_github_app_private_key" {
  secret_id = google_secret_manager_secret.github_app_private_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "web_webhook_secret" {
  secret_id = google_secret_manager_secret.webhook_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "web_github_oauth_client_secret" {
  secret_id = google_secret_manager_secret.github_oauth_client_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "web_session_secret" {
  secret_id = google_secret_manager_secret.session_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "web_demo_login_password" {
  count     = var.demo_login_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.demo_login_password[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_project_iam_member" "web_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.web.email}"
}

resource "google_project_iam_member" "worker_firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_project_iam_member" "web_cloud_tasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.web.email}"
}

resource "google_service_account_iam_member" "web_can_act_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.web.email}"
}

resource "google_cloud_tasks_queue" "worker" {
  name     = "rulebranch-worker"
  location = var.region
  # Keep queue fan-out aligned with the Worker service's instance and request
  # concurrency caps. This bounds downstream API pressure and spend while still
  # allowing five independent jobs to make progress.
  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 5
  }
  # Delivery-retry attempts (Cloud Tasks) are a different budget than
  # analysis_jobs.attempts (application handler failures, capped at 5 -> dead in
  # updateAnalysisJobStatus): the Worker's stale-running-lease recovery
  # (DEFAULT_STALE_RUNNING_LEASE, 15min) only gets a chance to run on a *redelivered*
  # task, so Cloud Tasks must keep retrying for meaningfully longer than that lease.
  # 20 attempts x up to 300s backoff comfortably spans well past 15 minutes even in
  # the worst case (every early attempt failing fast with 503 "leased").
  retry_config {
    max_attempts = 20
    min_backoff  = "10s"
    max_backoff  = "300s"
  }
}

resource "google_cloud_run_v2_service" "worker" {
  name     = local.worker_service_name
  location = var.region

  depends_on = [
    google_secret_manager_secret_iam_member.worker_github_app_private_key,
    google_secret_manager_secret_iam_member.worker_ai_api_key,
  ]

  template {
    service_account = google_service_account.worker.email
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
    # Analysis handlers use a per-job temporary workspace and can make expensive
    # model/GitHub calls. Give each container only one job at a time.
    max_instance_request_concurrency = 1
    # HTTP timeout does NOT terminate application code. Production Worker owns
    # a 540s hard execution deadline (process watchdog), checks attempt ownership
    # in Firestore transactions and rechecks compile ownership before GitHub I/O.
    # Keep that application deadline below this 600s HTTP timeout and the 15min
    # recovery lease. This ordering alone is not a stale-writer fencing mechanism.
    timeout = "600s"

    containers {
      image = var.worker_image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
      env {
        name = "WORKER_URL"
        # A service cannot reference its own computed URI from within its template
        # without creating a Terraform cycle. Supply its canonical URL explicitly.
        value = var.worker_url
      }
      env {
        # Cloud Tasks mints the Worker request token as this exact service account.
        # The application verifies the email claim as well as the token audience.
        name  = "WORKER_SERVICE_ACCOUNT_EMAIL"
        value = google_service_account.worker.email
      }
      env {
        name  = "GITHUB_APP_ID"
        value = var.github_app_id
      }
      env {
        name  = "RULEBRANCH_AI_PROVIDER"
        value = var.ai_provider
      }
      env {
        name  = "RULEBRANCH_AI_MODEL_FAST"
        value = var.ai_model_fast
      }
      env {
        name  = "RULEBRANCH_AI_MODEL_REASONING"
        value = var.ai_model_reasoning
      }
      env {
        name = "GITHUB_APP_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_app_private_key.secret_id
            version = "latest"
          }
        }
      }
      # google-genai reads GOOGLE_API_KEY for the gemini-api provider.
      env {
        name = "GOOGLE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.ai_api_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "web" {
  name     = local.web_service_name
  location = var.region

  depends_on = [
    google_secret_manager_secret_iam_member.web_github_app_private_key,
    google_secret_manager_secret_iam_member.web_webhook_secret,
    google_secret_manager_secret_iam_member.web_github_oauth_client_secret,
    google_secret_manager_secret_iam_member.web_session_secret,
    google_secret_manager_secret_iam_member.web_demo_login_password,
  ]

  template {
    service_account = google_service_account.web.email
    scaling {
      # Keep a request-ready instance for interactive traffic by default. The
      # variable lets cost-sensitive environments opt back into scale-to-zero.
      min_instance_count = var.web_min_instance_count
      max_instance_count = 10
    }
    # Web handlers are mostly short-lived I/O. A moderate explicit cap prevents an
    # accidental/untrusted traffic spike from relying on Cloud Run's broad defaults.
    max_instance_request_concurrency = 40
    timeout                          = "60s"

    containers {
      image = var.web_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "FIRESTORE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "CLOUD_TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "CLOUD_TASKS_QUEUE"
        value = google_cloud_tasks_queue.worker.name
      }
      env {
        name  = "WORKER_URL"
        value = google_cloud_run_v2_service.worker.uri
      }
      env {
        name  = "WORKER_SERVICE_ACCOUNT_EMAIL"
        value = google_service_account.worker.email
      }
      env {
        name  = "GITHUB_APP_ID"
        value = var.github_app_id
      }
      env {
        name  = "GITHUB_APP_SLUG"
        value = var.github_app_slug
      }
      env {
        name  = "GITHUB_OAUTH_CLIENT_ID"
        value = var.github_oauth_client_id
      }
      env {
        name  = "RULEBRANCH_DEMO_LOGIN_ENABLED"
        value = var.demo_login_enabled ? "1" : "0"
      }
      env {
        name  = "RULEBRANCH_DEMO_LOGIN_ID"
        value = var.demo_login_id
      }
      dynamic "env" {
        for_each = var.demo_login_enabled ? [1] : []
        content {
          name = "RULEBRANCH_DEMO_LOGIN_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.demo_login_password[0].secret_id
              version = "latest"
            }
          }
        }
      }
      env {
        # Cloud Run's internal listener host is not the public URL registered
        # at GitHub, so OAuth redirects must use the configured canonical URL.
        name  = "RULEBRANCH_PUBLIC_URL"
        value = var.web_url
      }
      env {
        # A service cannot reference its own computed URI from within its template
        # without a Terraform cycle. Supply its canonical URL explicitly.
        name  = "SCHEDULER_OIDC_AUDIENCE"
        value = var.web_url
      }
      env {
        # A valid Google-signed token with the right audience alone is not enough:
        # GoogleOidcVerifier also checks the token's email claim against this, since
        # any GCP identity can mint an ID token for an arbitrary audience.
        name  = "SCHEDULER_SERVICE_ACCOUNT_EMAIL"
        value = google_service_account.scheduler.email
      }
      env {
        name = "RULEBRANCH_SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_APP_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_app_private_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.webhook_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_OAUTH_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_oauth_client_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  location = google_cloud_run_v2_service.worker.location
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_cloud_run_v2_service_iam_member" "web_public_invoker" {
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The web service's own application-layer OIDC verification (GoogleOidcVerifier, checked
# against SCHEDULER_OIDC_AUDIENCE) is the real security boundary here, not Cloud Run IAM —
# ingress is deliberately public (web_public_invoker) since normal user traffic is
# session-authenticated, not IAM-authenticated.
resource "google_cloud_scheduler_job" "purge_scan" {
  name      = "rulebranch-purge-scan"
  region    = var.region
  schedule  = "0 * * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "${var.web_url}/api/internal/purge-scan"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.web_url
    }
  }

  depends_on = [google_service_account_iam_member.scheduler_agent_can_impersonate]
}

resource "google_cloud_scheduler_job" "jobs_reconcile" {
  name      = "rulebranch-jobs-reconcile"
  region    = var.region
  schedule  = "*/5 * * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "${var.web_url}/api/internal/jobs-reconcile"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.web_url
    }
  }

  depends_on = [google_service_account_iam_member.scheduler_agent_can_impersonate]
}
