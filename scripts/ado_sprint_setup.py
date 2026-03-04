"""
Azure DevOps Sprint Automation Script
======================================
Runs every 15 days via an Azure Pipelines scheduled trigger.

Actions performed on each run:
  1. Creates a new iteration (sprint) node under the project's iteration tree.
  2. Assigns that iteration to the configured team.
  3. Creates the full Epic → Feature → User Story hierarchy from a YAML template.

Configuration — replace these placeholder values with your own, or set the
corresponding environment variables (preferred for secrets):

  ADO_ORG     = "YOUR_ORG_NAME"       # e.g. "contoso"
  ADO_PROJECT = "YOUR_PROJECT_NAME"   # e.g. "MyProject"
  ADO_TEAM    = "YOUR_TEAM_NAME"      # e.g. "MyProject Team"
  ADO_PAT     = "YOUR_PAT_HERE"       # Personal Access Token (keep secret!)
  TEMPLATE_PATH = "templates/work_items.yaml"

Required PAT scopes:
  - Work Items: Read & Write
  - Project and Team: Read
  - Iterations: Read & Write  (found under the Work Items scope group)

Exit codes:
  0  Success
  1  Configuration error (missing env var)
  2  API error (non-2xx response from Azure DevOps)
  3  Template error (file not found or YAML parse error)
"""

import base64
import json
import os
import sys
from datetime import date, timedelta
from urllib.parse import quote

import requests
import yaml

# ── Constants ─────────────────────────────────────────────────────────────────

API_VERSION = "7.1"
BASE_URL = "https://dev.azure.com"

# ADO field reference names
FIELD_TITLE               = "System.Title"
FIELD_DESCRIPTION         = "System.Description"
FIELD_TAGS                = "System.Tags"
FIELD_AREA_PATH           = "System.AreaPath"
FIELD_ITERATION_PATH      = "System.IterationPath"
FIELD_STORY_POINTS        = "Microsoft.VSTS.Scheduling.StoryPoints"
FIELD_PRIORITY            = "Microsoft.VSTS.Common.Priority"
FIELD_ACCEPTANCE_CRITERIA = "Microsoft.VSTS.Common.AcceptanceCriteria"

# Relation type that expresses "this item's parent is X"
RELATION_PARENT = "System.LinkTypes.Hierarchy-Reverse"

CONTENT_TYPE_JSON_PATCH = "application/json-patch+json"

# ── Entrypoint ────────────────────────────────────────────────────────────────


def main() -> None:
    config   = load_config()
    template = load_template(config["template_path"])

    session = build_session(config["pat"])

    sprint_cfg   = template.get("sprints", {})
    duration     = int(sprint_cfg.get("duration_days", 15))
    name_prefix  = sprint_cfg.get("name_prefix", "Sprint")

    start_date, end_date = calculate_sprint_dates(duration)
    sprint_name = build_sprint_name(name_prefix, start_date)

    print(f"\n=== Azure DevOps Sprint Setup ===")
    print(f"Organisation : {config['org']}")
    print(f"Project      : {config['project']}")
    print(f"Team         : {config['team']}")
    print(f"Sprint       : {sprint_name}  ({start_date} → {end_date})\n")

    print("[1/4] Enabling Epic & Feature backlog levels for team...")
    enable_backlog_levels(session, config["org"], config["project"], config["team"])
    print("      OK — Epic, Feature, User Story levels visible")

    print("[2/4] Creating iteration node...")
    iteration_guid = create_iteration(
        session, config["org"], config["project"],
        sprint_name, start_date, end_date,
    )
    print(f"      OK — GUID: {iteration_guid}")

    print("[3/4] Assigning iteration to team...")
    assign_iteration_to_team(
        session, config["org"], config["project"],
        config["team"], iteration_guid,
    )
    print(f"      OK — '{sprint_name}' assigned to '{config['team']}'")

    print("[4/4] Creating work item hierarchy...")
    create_work_item_hierarchy(
        session, config["org"], config["project"],
        template, sprint_name,
    )
    print("\n=== Done — all work items created successfully ===")


# ── Configuration ─────────────────────────────────────────────────────────────


def load_config() -> dict:
    """
    Read all required environment variables. Reports ALL missing variables
    before exiting so the user can fix everything in one go.
    """
    required = {
        "pat":           "ADO_PAT",
        "org":           "ADO_ORG",
        "project":       "ADO_PROJECT",
        "team":          "ADO_TEAM",
        "template_path": "TEMPLATE_PATH",
    }
    config: dict = {}
    missing: list = []
    for key, env_var in required.items():
        value = os.environ.get(env_var, "").strip()
        if not value:
            missing.append(env_var)
        else:
            config[key] = value

    if missing:
        print(
            f"ERROR: Missing required environment variables: {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)

    return config


def load_template(path: str) -> dict:
    """
    Parse the YAML template file. Exits with code 3 on any file/parse error.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except FileNotFoundError:
        print(f"ERROR: Template not found: {path}", file=sys.stderr)
        sys.exit(3)
    except yaml.YAMLError as exc:
        print(f"ERROR: YAML parse error in {path}:\n{exc}", file=sys.stderr)
        sys.exit(3)

    if not isinstance(data, dict) or "epics" not in data:
        print(
            f"ERROR: Template must be a YAML mapping with an 'epics' key.",
            file=sys.stderr,
        )
        sys.exit(3)

    return data


# ── Authentication ────────────────────────────────────────────────────────────


def build_auth_header(pat: str) -> dict:
    """
    Azure DevOps uses HTTP Basic auth with an empty username and the PAT as
    the password. The header value is: "Basic base64(:<PAT>)".
    """
    encoded = base64.b64encode(f":{pat}".encode("ascii")).decode("ascii")
    return {"Authorization": f"Basic {encoded}"}


def build_session(pat: str) -> requests.Session:
    """
    Returns a Session pre-configured with the ADO auth header and a default
    Content-Type of application/json. The work item endpoint overrides this
    per-call with application/json-patch+json.
    """
    session = requests.Session()
    session.headers.update(build_auth_header(pat))
    session.headers.update({"Content-Type": "application/json"})
    return session


# ── Date Helpers ──────────────────────────────────────────────────────────────


def calculate_sprint_dates(duration_days: int = 15) -> tuple:
    """
    Sprint starts today and lasts `duration_days` calendar days (inclusive).
    A 15-day sprint from March 4 ends on March 18: start + 14 days offset.
    """
    start = date.today()
    end   = start + timedelta(days=duration_days - 1)
    return start, end


def build_sprint_name(prefix: str, start_date: date) -> str:
    """
    Produces a unique, lexicographically sortable sprint name.
    Example: "Sprint 2026-03-04"
    """
    return f"{prefix} {start_date.isoformat()}"


def format_ado_date(d: date) -> str:
    """
    Azure DevOps iteration dates must be ISO 8601 with a time component.
    Plain date strings ("2026-03-04") are rejected by the API.
    """
    return f"{d.isoformat()}T00:00:00Z"


# ── Team Settings ────────────────────────────────────────────────────────────


def enable_backlog_levels(
    session: requests.Session,
    org: str,
    project: str,
    team: str,
) -> None:
    """
    PATCH /work/teamsettings
    Ensures Epics, Features, and User Stories are all visible on the team backlog.
    By default Azure DevOps hides the Epic level — this makes items invisible on
    the board even though they exist in the project.
    """
    encoded_team = quote(team, safe="")
    url = (
        f"{BASE_URL}/{org}/{project}/{encoded_team}"
        f"/_apis/work/teamsettings"
        f"?api-version={API_VERSION}"
    )
    payload = {
        "backlogVisibilities": {
            "Microsoft.EpicCategory":        True,
            "Microsoft.FeatureCategory":     True,
            "Microsoft.RequirementCategory": True,
        }
    }
    response = session.patch(url, json=payload)
    _raise_for_status(response)


# ── Iteration API ─────────────────────────────────────────────────────────────


def create_iteration(
    session: requests.Session,
    org: str,
    project: str,
    sprint_name: str,
    start_date: date,
    end_date: date,
) -> str:
    """
    POST /wit/classificationnodes/iterations
    Creates a new iteration node directly under the root iteration tree.
    Returns the iteration GUID (not the integer id), which is required by
    the team assignment endpoint.
    """
    url = (
        f"{BASE_URL}/{org}/{project}"
        f"/_apis/wit/classificationnodes/iterations"
        f"?api-version={API_VERSION}"
    )
    payload = {
        "name": sprint_name,
        "attributes": {
            "startDate":  format_ado_date(start_date),
            "finishDate": format_ado_date(end_date),
        },
    }
    response = session.post(url, json=payload)
    _raise_for_status(response)
    return response.json()["identifier"]


def assign_iteration_to_team(
    session: requests.Session,
    org: str,
    project: str,
    team: str,
    iteration_id: str,
) -> None:
    """
    POST /work/teamsettings/iterations
    Assigns the iteration (identified by its GUID) to the specified team.
    The team name is URL-encoded to handle spaces and special characters.
    """
    encoded_team = quote(team, safe="")
    url = (
        f"{BASE_URL}/{org}/{project}/{encoded_team}"
        f"/_apis/work/teamsettings/iterations"
        f"?api-version={API_VERSION}"
    )
    payload = {"id": iteration_id}
    response = session.post(url, json=payload)
    _raise_for_status(response)


# ── Work Item API ─────────────────────────────────────────────────────────────


def build_patch_document(
    fields: dict,
    parent_id,
    org: str,
    project: str,
) -> list:
    """
    Constructs a JSON Patch document (list of operations) for work item creation.

    Maps template field keys to ADO field reference names and adds an optional
    parent relation using System.LinkTypes.Hierarchy-Reverse.

    Pure function — no I/O.
    """
    field_map = {
        "title":               FIELD_TITLE,
        "description":         FIELD_DESCRIPTION,
        "tags":                FIELD_TAGS,
        "area_path":           FIELD_AREA_PATH,
        "iteration_path":      FIELD_ITERATION_PATH,
        "story_points":        FIELD_STORY_POINTS,
        "priority":            FIELD_PRIORITY,
        "acceptance_criteria": FIELD_ACCEPTANCE_CRITERIA,
    }

    ops = []
    for template_key, ado_field in field_map.items():
        value = fields.get(template_key)
        if value is None or value == "":
            continue
        ops.append({"op": "add", "path": f"/fields/{ado_field}", "value": value})

    if parent_id is not None:
        parent_url = f"{BASE_URL}/{org}/{project}/_apis/wit/workitems/{parent_id}"
        ops.append({
            "op": "add",
            "path": "/relations/-",   # "-" appends to the relations array
            "value": {
                "rel": RELATION_PARENT,
                "url": parent_url,
                "attributes": {"comment": "Auto-linked by sprint setup script"},
            },
        })

    return ops


def create_work_item(
    session: requests.Session,
    org: str,
    project: str,
    work_item_type: str,
    fields: dict,
    parent_id=None,
) -> int:
    """
    PATCH /wit/workitems/${type}

    IMPORTANT — the '$' before the work item type is a literal character
    required by the Azure DevOps REST API. It is NOT a Python f-string variable.

    IMPORTANT — this endpoint requires Content-Type: application/json-patch+json,
    not the session default of application/json. The header is overridden here.
    The body must be sent via `data=` (not `json=`) to prevent requests from
    reverting the Content-Type.

    Returns the integer ID of the newly created work item.
    """
    # The $ is literal in the ADO URL, not a Python variable
    url = (
        f"{BASE_URL}/{org}/{project}"
        f"/_apis/wit/workitems/${work_item_type}"
        f"?api-version={API_VERSION}"
    )
    patch_doc = build_patch_document(fields, parent_id, org, project)
    response = session.patch(
        url,
        data=json.dumps(patch_doc),
        headers={"Content-Type": CONTENT_TYPE_JSON_PATCH},
    )
    _raise_for_status(response)
    item_id = response.json()["id"]
    indent = "    " if work_item_type == "User Story" else ("  " if work_item_type == "Feature" else "")
    print(f"      {indent}[{work_item_type}] '{fields.get('title')}' → ID {item_id}")
    return item_id


def create_work_item_hierarchy(
    session: requests.Session,
    org: str,
    project: str,
    template: dict,
    sprint_name: str,
) -> None:
    """
    Walks the template hierarchy depth-first and creates all work items in the
    correct order so that parent IDs are always available when children are created.

    Iteration path format: "{project}\\{sprint_name}"
    The backslash is the ADO path separator (a real backslash, not a slash).
    """
    iteration_path = f"{project}\\{sprint_name}"

    for epic_def in template.get("epics", []):
        epic_fields = {
            "title":          epic_def["title"],
            "description":    epic_def.get("description", ""),
            "tags":           epic_def.get("tags", ""),
            "area_path":      epic_def.get("area_path", ""),
            "iteration_path": iteration_path,
        }
        epic_id = create_work_item(session, org, project, "Epic", epic_fields)

        for feature_def in epic_def.get("features", []):
            feature_fields = {
                "title":          feature_def["title"],
                "description":    feature_def.get("description", ""),
                "tags":           feature_def.get("tags", ""),
                "iteration_path": iteration_path,
            }
            feature_id = create_work_item(
                session, org, project, "Feature",
                feature_fields, parent_id=epic_id,
            )

            for story_def in feature_def.get("user_stories", []):
                story_fields = {
                    "title":               story_def["title"],
                    "description":         story_def.get("description", ""),
                    "acceptance_criteria": story_def.get("acceptance_criteria", ""),
                    "story_points":        story_def.get("story_points"),
                    "priority":            story_def.get("priority"),
                    "iteration_path":      iteration_path,
                }
                create_work_item(
                    session, org, project, "User Story",
                    story_fields, parent_id=feature_id,
                )


# ── Error Handling ────────────────────────────────────────────────────────────


def _raise_for_status(response: requests.Response) -> None:
    """
    Raises a descriptive error on non-2xx responses, including the ADO error
    body so the user can diagnose the problem without reading raw HTTP logs.
    """
    if response.ok:
        return
    try:
        error_body = response.json()
        message = error_body.get("message", response.text)
    except ValueError:
        message = response.text
    print(
        f"ERROR: ADO API returned {response.status_code}: {message}",
        file=sys.stderr,
    )
    sys.exit(2)


# ── Script Entry ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
