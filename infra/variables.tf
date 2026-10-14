variable "project_id" {
  type = string
}
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "web_image" {
  # No default: gcr.io/cloudrun/hello silently deploys Google's sample container instead
  # of RuleBranch if a real image isn't supplied. Build and push apps/web's Dockerfile
  # first (see apps/web/Dockerfile), then pass its tag here.
  type = string
}

variable "web_min_instance_count" {
  description = "Minimum warm Web instances; set to 0 to prefer scale-to-zero cost over cold-start latency."
  type        = number
  default     = 1

  validation {
    condition     = var.web_min_instance_count >= 0 && var.web_min_instance_count <= 10 && floor(var.web_min_instance_count) == var.web_min_instance_count
    error_message = "web_min_instance_count must be an integer between 0 and the Web maximum of 10."
  }
}

variable "worker_image" {
  # No default, for the same reason as web_image. Build and push apps/worker/Dockerfile.
  type = string
}

variable "web_url" {
  type        = string
  description = "Canonical Cloud Run URL for the Web service, used as the Scheduler OIDC audience."
}

variable "worker_url" {
  type        = string
  description = "Canonical Cloud Run URL for the Worker service, used as the Worker OIDC audience."
}

variable "github_app_id" {
  type = string
}

variable "github_app_slug" {
  description = "GitHub App URL slug used by the Web service to build the installation URL."
  type        = string

  validation {
    condition     = length(trimspace(var.github_app_slug)) > 0
    error_message = "github_app_slug must not be empty."
  }
}

variable "github_oauth_client_id" {
  type = string
}

variable "demo_login_enabled" {
  description = "Enable the read-only judge demo login on the public login page."
  type        = bool
  default     = false
}

variable "demo_login_id" {
  description = "Non-secret login ID shared with hackathon judges when demo_login_enabled is true."
  type        = string
  default     = "zenn-judge"

  validation {
    condition     = length(trimspace(var.demo_login_id)) >= 3 && length(var.demo_login_id) <= 128
    error_message = "demo_login_id must be between 3 and 128 characters."
  }
}

variable "ai_provider" {
  type    = string
  default = "gemini-api"
}

variable "ai_model_fast" {
  type    = string
  default = "gemini-2.5-flash"
}

variable "ai_model_reasoning" {
  type    = string
  default = "gemini-2.5-pro"
}
