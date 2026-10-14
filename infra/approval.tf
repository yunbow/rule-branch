# Optional private evaluator. Reuses the web image, not the public web identity.
# Existing installations remain manual until an operator explicitly opts in.
variable "approval_mode" {
  type    = string
  default = "manual"
  validation {
    condition     = contains(["manual", "shadow", "auto"], var.approval_mode)
    error_message = "approval_mode must be manual, shadow, or auto."
  }
}

variable "approval_workspace_ids" {
  type    = list(string)
  default = []
  validation {
    condition     = length(var.approval_workspace_ids) <= 20 && alltrue([for id in var.approval_workspace_ids : can(regex("^[A-Za-z0-9_-]{1,128}$", id))])
    error_message = "Specify at most 20 valid Workspace IDs."
  }
}

variable "approval_model" {
  type        = string
  default     = ""
  description = "Explicit Gemini model ID available to this project; no moving default."
}

variable "approval_location" {
  type    = string
  default = "us-central1"
}

variable "approval_model_armor_template" {
  type        = string
  default     = ""
  description = "Existing projects/PROJECT/locations/REGION/templates/NAME with prompt-injection detection enabled."
}

variable "approval_min_judge_score" {
  type    = number
  default = 0.95
  validation {
    condition     = var.approval_min_judge_score >= 0.9 && var.approval_min_judge_score <= 1
    error_message = "Use a threshold between 0.9 and 1; this is not a correctness probability."
  }
}

variable "approval_min_groundedness_confidence" {
  type    = number
  default = 0.95
  validation {
    condition     = var.approval_min_groundedness_confidence >= 0.9 && var.approval_min_groundedness_confidence <= 1
    error_message = "Use a threshold between 0.9 and 1."
  }
}

locals {
  approval_enabled = var.approval_mode != "manual" && length(var.approval_workspace_ids) > 0
  approval_url     = "https://rulebranch-approval-${data.google_project.current.number}.${var.region}.run.app"

  approval_env = {
    FIRESTORE_PROJECT_ID = var.project_id

    GOOGLE_CLOUD_PROJECT = var.project_id

    CLOUD_TASKS_LOCATION = var.region

    CLOUD_TASKS_QUEUE = google_cloud_tasks_queue.worker.name

    WORKER_URL = google_cloud_run_v2_service.worker.uri

    WORKER_SERVICE_ACCOUNT_EMAIL = google_service_account.worker.email

    SCHEDULER_OIDC_AUDIENCE = local.approval_url

    SCHEDULER_SERVICE_ACCOUNT_EMAIL = google_service_account.scheduler.email

    RULEBRANCH_APPROVAL_MODE = var.approval_mode

    RULEBRANCH_APPROVAL_WORKSPACE_IDS = join(",", var.approval_workspace_ids)

    RULEBRANCH_APPROVAL_MODEL = var.approval_model

    RULEBRANCH_APPROVAL_LOCATION = var.approval_location

    RULEBRANCH_MODEL_ARMOR_TEMPLATE = var.approval_model_armor_template

    RULEBRANCH_APPROVAL_MIN_JUDGE_SCORE = tostring(var.approval_min_judge_score)

    RULEBRANCH_APPROVAL_MIN_GROUNDEDNESS_CONFIDENCE = tostring(var.approval_min_groundedness_confidence)

    RULEBRANCH_APPROVAL_MAX_PER_SCAN = "2"

    RULEBRANCH_APPROVAL_TIMEOUT_MS = "15000"
  }
}

resource "google_project_service" "approval" {
  for_each           = local.approval_enabled ? toset(["aiplatform.googleapis.com", "modelarmor.googleapis.com"]) : toset([])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "approval" {
  count        = local.approval_enabled ? 1 : 0
  account_id   = "rulebranch-approval"
  display_name = "RuleBranch private approval evaluator"
}

resource "google_project_iam_member" "approval" {
  for_each = local.approval_enabled ? toset(["roles/datastore.user", "roles/cloudtasks.enqueuer", "roles/aiplatform.user", "roles/modelarmor.user"]) : toset([])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.approval[0].email}"
}

resource "google_service_account_iam_member" "approval_can_dispatch_worker" {
  count              = local.approval_enabled ? 1 : 0
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.approval[0].email}"
}

resource "google_secret_manager_secret_iam_member" "approval_session_secret" {
  count     = local.approval_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.approval_session_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.approval[0].email}"
}

resource "google_cloud_run_v2_service" "approval" {
  count    = local.approval_enabled ? 1 : 0
  name     = "rulebranch-approval"
  location = var.region

  template {
    service_account = google_service_account.approval[0].email
    timeout         = "300s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    max_instance_request_concurrency = 1
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
      dynamic "env" {
        for_each = local.approval_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "RULEBRANCH_SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.approval_session_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = can(regex("^gemini-[A-Za-z0-9._-]+$", var.approval_model)) && can(regex("^projects/[A-Za-z0-9-]+/locations/[a-z0-9-]+/templates/[A-Za-z0-9_-]+$", var.approval_model_armor_template))
      error_message = "Approval evaluation requires an explicit Gemini model and Model Armor template."
    }
  }
  depends_on = [google_project_service.approval, google_project_iam_member.approval, google_secret_manager_secret_iam_member.approval_session_secret]
}

# No allUsers binding. Cloud Run IAM and application OIDC checks both apply.
resource "google_cloud_run_v2_service_iam_member" "approval_scheduler_invoker" {
  count    = local.approval_enabled ? 1 : 0
  location = google_cloud_run_v2_service.approval[0].location
  name     = google_cloud_run_v2_service.approval[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "approval_scan" {
  count            = local.approval_enabled ? 1 : 0
  name             = "rulebranch-approval-scan"
  region           = var.region
  schedule         = "* * * * *"
  time_zone        = "UTC"
  attempt_deadline = "300s"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.approval[0].uri}/api/internal/approval-scan"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.approval_url
    }
  }
  depends_on = [google_service_account_iam_member.scheduler_agent_can_impersonate, google_cloud_run_v2_service_iam_member.approval_scheduler_invoker, google_service_account_iam_member.approval_can_dispatch_worker]
}
