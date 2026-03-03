"""
workflow_editor.py — Phase 5 Custom Workflow Editor

This module provides a workflow DSL/editor for customizing deployment workflows:
- Workflow DSL schema definition
- CLI-guided workflow editor
- Validation and dry-run
- Persist workflows in repo
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any


class WorkflowEvent(str, Enum):
    """Events that can trigger a workflow."""
    PUSH = "push"
    PULL_REQUEST = "pull_request"
    MANUAL = "manual"
    SCHEDULE = "schedule"
    TAG = "tag"


class WorkflowAction(str, Enum):
    """Actions available in a workflow."""
    CHECKOUT = "checkout"
    SETUP_NODE = "setup_node"
    SETUP_PYTHON = "setup_python"
    INSTALL = "install"
    LINT = "lint"
    TEST = "test"
    BUILD = "build"
    DEPLOY = "deploy"
    NOTIFY = "notify"
    APPROVAL = "approval"
    CUSTOM = "custom"


@dataclass
class WorkflowStep:
    """A single step in a workflow."""
    id: str
    name: str
    action: WorkflowAction
    config: dict[str, Any] = field(default_factory=dict)
    condition: str | None = None
    continue_on_error: bool = False


@dataclass
class WorkflowJob:
    """A job containing multiple steps that run on a runner."""
    id: str
    name: str
    runs_on: str
    steps: list[WorkflowStep] = field(default_factory=list)
    if_condition: str | None = None
    needs: list[str] = field(default_factory=list)


@dataclass
class WorkflowEnvironment:
    """Environment configuration for deployment."""
    name: str
    url: str
    branch: str
    variables: dict[str, str] = field(default_factory=dict)
    secrets: list[str] = field(default_factory=list)


@dataclass
class Workflow:
    """Complete workflow definition."""
    name: str
    description: str = ""
    on: list[WorkflowEvent] = field(default_factory=list)
    branches: list[str] = field(default_factory=lambda: ["main", "master"])
    jobs: list[WorkflowJob] = field(default_factory=list)
    environments: list[WorkflowEnvironment] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)


class WorkflowValidationError(Exception):
    """Raised when workflow validation fails."""
    pass


class WorkflowEditor:
    """
    Editor for creating and modifying CI/CD workflows.

    Usage:
        editor = WorkflowEditor(project_dir=".")
        workflow = editor.create_workflow("Deploy")
        editor.add_job(workflow, "deploy", runs_on="ubuntu-latest")
        editor.add_step(workflow, "deploy", "Deploy", WorkflowAction.DEPLOY)
        editor.validate(workflow)
        editor.save(workflow)
    """

    def __init__(
        self,
        project_dir: str = ".",
        workflow_dir: str = ".pakalon/workflows",
    ):
        self.project_dir = Path(project_dir)
        self.workflow_dir = self.project_dir / workflow_dir
        self.workflow_dir.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------------------
    # Workflow Creation
    # -------------------------------------------------------------------------

    def create_workflow(
        self,
        name: str,
        description: str = "",
        on: list[WorkflowEvent] | None = None,
    ) -> Workflow:
        """Create a new workflow."""
        return Workflow(
            name=name,
            description=description,
            on=on or [WorkflowEvent.PUSH],
            jobs=[],
        )

    def add_job(
        self,
        workflow: Workflow,
        job_id: str,
        name: str,
        runs_on: str = "ubuntu-latest",
        if_condition: str | None = None,
        needs: list[str] | None = None,
    ) -> WorkflowJob:
        """Add a job to a workflow."""
        job = WorkflowJob(
            id=job_id,
            name=name,
            runs_on=runs_on,
            if_condition=if_condition,
            needs=needs or [],
        )
        workflow.jobs.append(job)
        return job

    def add_step(
        self,
        workflow: Workflow,
        job_id: str,
        step_id: str,
        name: str,
        action: WorkflowAction,
        config: dict[str, Any] | None = None,
        condition: str | None = None,
        continue_on_error: bool = False,
    ) -> WorkflowStep:
        """Add a step to a job."""
        job = next((j for j in workflow.jobs if j.id == job_id), None)
        if not job:
            raise WorkflowValidationError(f"Job {job_id} not found")

        step = WorkflowStep(
            id=step_id,
            name=name,
            action=action,
            config=config or {},
            condition=condition,
            continue_on_error=continue_on_error,
        )
        job.steps.append(step)
        return step

    def add_environment(
        self,
        workflow: Workflow,
        name: str,
        url: str,
        branch: str = "main",
        variables: dict[str, str] | None = None,
        secrets: list[str] | None = None,
    ) -> WorkflowEnvironment:
        """Add an environment to a workflow."""
        env = WorkflowEnvironment(
            name=name,
            url=url,
            branch=branch,
            variables=variables or {},
            secrets=secrets or [],
        )
        workflow.environments.append(env)
        return env

    # -------------------------------------------------------------------------
    # Validation
    # -------------------------------------------------------------------------

    def validate(self, workflow: Workflow) -> list[str]:
        """Validate a workflow and return list of errors."""
        errors = []

        # Check name
        if not workflow.name:
            errors.append("Workflow must have a name")

        # Check events
        if not workflow.on:
            errors.append("Workflow must have at least one trigger event")

        # Check jobs
        if not workflow.jobs:
            errors.append("Workflow must have at least one job")

        # Check each job
        job_ids = set()
        for job in workflow.jobs:
            # Check job ID uniqueness
            if job.id in job_ids:
                errors.append(f"Duplicate job ID: {job.id}")
            job_ids.add(job.id)

            # Check job has steps
            if not job.steps:
                errors.append(f"Job {job.id} must have at least one step")

            # Check step IDs
            step_ids = set()
            for step in job.steps:
                if step.id in step_ids:
                    errors.append(f"Duplicate step ID {step.id} in job {job.id}")
                step_ids.add(step.id)

                # Validate action config
                if step.action == WorkflowAction.SETUP_NODE:
                    if "node-version" not in step.config:
                        errors.append(f"Step {step.id}: setup_node requires node-version")
                elif step.action == WorkflowAction.SETUP_PYTHON:
                    if "python-version" not in step.config:
                        errors.append(f"Step {step.id}: setup_python requires python-version")

            # Check job dependencies exist
            for need in job.needs:
                if need not in job_ids:
                    errors.append(f"Job {job.id}: dependency {need} does not exist")

        return errors

    def validate_or_raise(self, workflow: Workflow):
        """Validate workflow and raise if invalid."""
        errors = self.validate(workflow)
        if errors:
            raise WorkflowValidationError("\n".join(errors))

    # -------------------------------------------------------------------------
    # Serialization
    # -------------------------------------------------------------------------

    def to_github_actions(self, workflow: Workflow) -> dict:
        """Convert workflow to GitHub Actions format."""
        result = {
            "name": workflow.name,
            "on": {},
        }

        # Add triggers
        for event in workflow.on:
            if event == WorkflowEvent.PUSH:
                result["on"]["push"] = {
                    "branches": workflow.branches,
                }
            elif event == WorkflowEvent.PULL_REQUEST:
                result["on"]["pull_request"] = {
                    "branches": workflow.branches,
                }
            elif event == WorkflowEvent.MANUAL:
                result["on"]["workflow_dispatch"] = {
                    "inputs": {
                        "environment": {
                            "description": "Deployment environment",
                            "required": True,
                            "type": "choice",
                            "options": [e.name for e in workflow.environments],
                        },
                    },
                }
            elif event == WorkflowEvent.SCHEDULE:
                result["on"]["schedule"] = [{"cron": "0 0 * * *"}]

        # Add jobs
        result["jobs"] = {}
        for job in workflow.jobs:
            job_dict = {
                "name": job.name,
                "runs-on": job.runs_on,
                "steps": [],
            }

            if job.if_condition:
                job_dict["if"] = job.if_condition

            if job.needs:
                job_dict["needs"] = job.needs

            for step in job.steps:
                step_dict = self._step_to_github_actions(step)
                job_dict["steps"].append(step_dict)

            result["jobs"][job.id] = job_dict

        # Add environments
        if workflow.environments:
            for job in result["jobs"].values():
                if "deploy" in job["name"].lower():
                    job["environment"] = {
                        "name": workflow.environments[0].name,
                        "url": workflow.environments[0].url,
                    }

        return result

    def _step_to_github_actions(self, step: WorkflowStep) -> dict:
        """Convert a step to GitHub Actions format."""
        result = {
            "name": step.name,
        }

        if step.condition:
            result["if"] = step.condition

        if step.continue_on_error:
            result["continue-on-error"] = True

        # Map actions to GitHub Actions
        action_map = {
            WorkflowAction.CHECKOUT: {
                "uses": "actions/checkout@v4",
            },
            WorkflowAction.SETUP_NODE: {
                "uses": "actions/setup-node@v4",
                "with": {"node-version": step.config.get("node-version", "20")},
            },
            WorkflowAction.SETUP_PYTHON: {
                "uses": "actions/setup-python@v5",
                "with": {"python-version": step.config.get("python-version", "3.12")},
            },
            WorkflowAction.INSTALL: {
                "run": step.config.get("command", "npm install"),
            },
            WorkflowAction.LINT: {
                "run": step.config.get("command", "npm run lint"),
            },
            WorkflowAction.TEST: {
                "run": step.config.get("command", "npm test"),
            },
            WorkflowAction.BUILD: {
                "run": step.config.get("command", "npm run build"),
            },
            WorkflowAction.DEPLOY: {
                "run": step.config.get("command", "echo 'Deploying...'"),
            },
            WorkflowAction.NOTIFY: {
                "run": step.config.get("command", "echo 'Notifying...'"),
            },
            WorkflowAction.CUSTOM: {
                "run": step.config.get("command", ""),
            },
        }

        action_config = action_map.get(step.action, {})
        result.update(action_config)

        return result

    def save(self, workflow: Workflow, filename: str | None = None):
        """Save workflow to file."""
        self.validate_or_raise(workflow)

        filename = filename or f"{workflow.name.lower().replace(' ', '-')}.json"
        filepath = self.workflow_dir / filename

        data = {
            "name": workflow.name,
            "description": workflow.description,
            "on": [e.value for e in workflow.on],
            "branches": workflow.branches,
            "jobs": [
                {
                    "id": job.id,
                    "name": job.name,
                    "runs_on": job.runs_on,
                    "if": job.if_condition,
                    "needs": job.needs,
                    "steps": [
                        {
                            "id": step.id,
                            "name": step.name,
                            "action": step.action.value,
                            "config": step.config,
                            "condition": step.condition,
                            "continue_on_error": step.continue_on_error,
                        }
                        for step in job.steps
                    ],
                }
                for job in workflow.jobs
            ],
            "environments": [
                {
                    "name": env.name,
                    "url": env.url,
                    "branch": env.branch,
                    "variables": env.variables,
                    "secrets": env.secrets,
                }
                for env in workflow.environments
            ],
            "created_at": workflow.created_at.isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

        # Also save as GitHub Actions workflow
        self._save_github_actions(workflow, data)

        return str(filepath)

    def _save_github_actions(self, workflow: Workflow, data: dict):
        """Save workflow as GitHub Actions YAML."""
        import yaml

        gh_actions = self.to_github_actions(workflow)

        # Save to .github/workflows/
        workflows_dir = self.project_dir / ".github" / "workflows"
        workflows_dir.mkdir(parents=True, exist_ok=True)

        filename = f"{workflow.name.lower().replace(' ', '-')}.yml"
        filepath = workflows_dir / filename

        with open(filepath, "w") as f:
            yaml.dump(gh_actions, f, default_flow_style=False, sort_keys=False)

    def load(self, filename: str) -> Workflow | None:
        """Load workflow from file."""
        filepath = self.workflow_dir / filename
        if not filepath.exists():
            return None

        with open(filepath) as f:
            data = json.load(f)

        return self._from_dict(data)

    def _from_dict(self, data: dict) -> Workflow:
        """Create workflow from dictionary."""
        return Workflow(
            name=data["name"],
            description=data.get("description", ""),
            on=[WorkflowEvent(e) for e in data.get("on", [])],
            branches=data.get("branches", ["main"]),
            jobs=[
                WorkflowJob(
                    id=job["id"],
                    name=job["name"],
                    runs_on=job.get("runs_on", "ubuntu-latest"),
                    if_condition=job.get("if"),
                    needs=job.get("needs", []),
                    steps=[
                        WorkflowStep(
                            id=step["id"],
                            name=step["name"],
                            action=WorkflowAction(step["action"]),
                            config=step.get("config", {}),
                            condition=step.get("condition"),
                            continue_on_error=step.get("continue_on_error", False),
                        )
                        for step in job.get("steps", [])
                    ],
                )
                for job in data.get("jobs", [])
            ],
            environments=[
                WorkflowEnvironment(
                    name=env["name"],
                    url=env["url"],
                    branch=env.get("branch", "main"),
                    variables=env.get("variables", {}),
                    secrets=env.get("secrets", []),
                )
                for env in data.get("environments", [])
            ],
            created_at=datetime.fromisoformat(data.get("created_at", datetime.utcnow().isoformat())),
            updated_at=datetime.fromisoformat(data.get("updated_at", datetime.utcnow().isoformat())),
        )

    # -------------------------------------------------------------------------
    # Dry Run
    # -------------------------------------------------------------------------

    def dry_run(self, workflow: Workflow) -> str:
        """Preview what the workflow will do without executing."""
        lines = []
        lines.append(f"Workflow: {workflow.name}")
        lines.append(f"Triggers: {', '.join(e.value for e in workflow.on)}")
        lines.append("")

        for job in workflow.jobs:
            lines.append(f"Job: {job.name} ({job.id})")
            lines.append(f"  Runs on: {job.runs_on}")

            if job.needs:
                lines.append(f"  Needs: {', '.join(job.needs)}")

            for step in job.steps:
                lines.append(f"  Step: {step.name}")
                lines.append(f"    Action: {step.action.value}")

                if step.config:
                    lines.append(f"    Config: {json.dumps(step.config)}")

                if step.condition:
                    lines.append(f"    If: {step.condition}")

            lines.append("")

        return "\n".join(lines)

    # -------------------------------------------------------------------------
    # List Workflows
    # -------------------------------------------------------------------------

    def list_workflows(self) -> list[dict]:
        """List all workflows in the project."""
        workflows = []

        for filepath in self.workflow_dir.glob("*.json"):
            try:
                with open(filepath) as f:
                    data = json.load(f)
                    workflows.append({
                        "name": data.get("name", filepath.stem),
                        "file": str(filepath.relative_to(self.project_dir)),
                        "updated_at": data.get("updated_at"),
                    })
            except Exception:
                pass

        return workflows


# -------------------------------------------------------------------------
# CLI Helpers
# -------------------------------------------------------------------------

def create_workflow_editor(project_dir: str = ".") -> WorkflowEditor:
    """Create a workflow editor instance."""
    return WorkflowEditor(project_dir=project_dir)


async def cmd_workflow_create(
    name: str,
    description: str = "",
    project_dir: str = ".",
) -> dict:
    """Create a new workflow."""
    editor = create_workflow_editor(project_dir)
    workflow = editor.create_workflow(name, description)
    filepath = editor.save(workflow)

    return {
        "status": "created",
        "workflow": name,
        "file": filepath,
    }


async def cmd_workflow_list(project_dir: str = ".") -> dict:
    """List all workflows."""
    editor = create_workflow_editor(project_dir)
    workflows = editor.list_workflows()

    return {
        "workflows": workflows,
    }


async def cmd_workflow_validate(
    filename: str,
    project_dir: str = ".",
) -> dict:
    """Validate a workflow."""
    editor = create_workflow_editor(project_dir)
    workflow = editor.load(filename)

    if not workflow:
        return {"valid": False, "errors": ["Workflow not found"]}

    errors = editor.validate(workflow)

    return {
        "valid": len(errors) == 0,
        "errors": errors,
    }


async def cmd_workflow_dry_run(
    filename: str,
    project_dir: str = ".",
) -> dict:
    """Preview a workflow."""
    editor = create_workflow_editor(project_dir)
    workflow = editor.load(filename)

    if not workflow:
        return {"error": "Workflow not found"}

    preview = editor.dry_run(workflow)

    return {
        "workflow": workflow.name,
        "preview": preview,
    }


async def cmd_workflow_generate_template(
    template: str,
    project_dir: str = ".",
) -> dict:
    """Generate a workflow from a template."""
    editor = create_workflow_editor(project_dir)

    templates = {
        "node": _create_node_template,
        "python": _create_python_template,
        "fullstack": _create_fullstack_template,
        "deploy": _create_deploy_template,
    }

    if template not in templates:
        return {"error": f"Unknown template: {template}. Available: {', '.join(templates.keys())}"}

    workflow = templates[template]()
    filepath = editor.save(workflow)

    return {
        "status": "created",
        "workflow": workflow.name,
        "file": filepath,
    }


def _create_node_template() -> Workflow:
    """Create a Node.js workflow template."""
    workflow = Workflow(
        name="Node.js CI",
        description="Continuous integration for Node.js projects",
        on=[WorkflowEvent.PUSH, WorkflowEvent.PULL_REQUEST],
    )

    job = WorkflowJob(
        id="build",
        name="Build and Test",
        runs_on="ubuntu-latest",
    )
    workflow.jobs.append(job)

    # Checkout
    job.steps.append(WorkflowStep(
        id="checkout",
        name="Checkout code",
        action=WorkflowAction.CHECKOUT,
    ))

    # Setup Node
    job.steps.append(WorkflowStep(
        id="setup",
        name="Setup Node.js",
        action=WorkflowAction.SETUP_NODE,
        config={"node-version": "20"},
    ))

    # Install
    job.steps.append(WorkflowStep(
        id="install",
        name="Install dependencies",
        action=WorkflowAction.INSTALL,
        config={"command": "npm ci"},
    ))

    # Lint
    job.steps.append(WorkflowStep(
        id="lint",
        name="Run linter",
        action=WorkflowAction.LINT,
        config={"command": "npm run lint"},
        continue_on_error=True,
    ))

    # Test
    job.steps.append(WorkflowStep(
        id="test",
        name="Run tests",
        action=WorkflowAction.TEST,
        config={"command": "npm test"},
    ))

    # Build
    job.steps.append(WorkflowStep(
        id="build",
        name="Build",
        action=WorkflowAction.BUILD,
        config={"command": "npm run build"},
    ))

    return workflow


def _create_python_template() -> Workflow:
    """Create a Python workflow template."""
    workflow = Workflow(
        name="Python CI",
        description="Continuous integration for Python projects",
        on=[WorkflowEvent.PUSH, WorkflowEvent.PULL_REQUEST],
    )

    job = WorkflowJob(
        id="build",
        name="Build and Test",
        runs_on="ubuntu-latest",
    )
    workflow.jobs.append(job)

    job.steps.append(WorkflowStep(
        id="checkout",
        name="Checkout code",
        action=WorkflowAction.CHECKOUT,
    ))

    job.steps.append(WorkflowStep(
        id="setup",
        name="Setup Python",
        action=WorkflowAction.SETUP_PYTHON,
        config={"python-version": "3.12"},
    ))

    job.steps.append(WorkflowStep(
        id="install",
        name="Install dependencies",
        action=WorkflowAction.INSTALL,
        config={"command": "pip install -r requirements.txt"},
    ))

    job.steps.append(WorkflowStep(
        id="lint",
        name="Run linter",
        action=WorkflowAction.LINT,
        config={"command": "ruff check ."},
        continue_on_error=True,
    ))

    job.steps.append(WorkflowStep(
        id="test",
        name="Run tests",
        action=WorkflowAction.TEST,
        config={"command": "pytest"},
    ))

    return workflow


def _create_fullstack_template() -> Workflow:
    """Create a fullstack deployment workflow."""
    workflow = Workflow(
        name="Fullstack Deploy",
        description="Fullstack application with deployment",
        on=[WorkflowEvent.PUSH],
    )

    # Build job
    build_job = WorkflowJob(
        id="build",
        name="Build",
        runs_on="ubuntu-latest",
    )
    workflow.jobs.append(build_job)

    build_job.steps.append(WorkflowStep(
        id="checkout",
        name="Checkout",
        action=WorkflowAction.CHECKOUT,
    ))

    build_job.steps.append(WorkflowStep(
        id="setup",
        name="Setup Node",
        action=WorkflowAction.SETUP_NODE,
        config={"node-version": "20"},
    ))

    build_job.steps.append(WorkflowStep(
        id="install",
        name="Install",
        action=WorkflowAction.INSTALL,
        config={"command": "npm ci"},
    ))

    build_job.steps.append(WorkflowStep(
        id="test",
        name="Test",
        action=WorkflowAction.TEST,
        config={"command": "npm test"},
    ))

    build_job.steps.append(WorkflowStep(
        id="build",
        name="Build",
        action=WorkflowAction.BUILD,
        config={"command": "npm run build"},
    ))

    # Deploy job
    deploy_job = WorkflowJob(
        id="deploy",
        name="Deploy",
        runs_on="ubuntu-latest",
        needs=["build"],
    )
    workflow.jobs.append(deploy_job)

    deploy_job.steps.append(WorkflowStep(
        id="checkout",
        name="Checkout",
        action=WorkflowAction.CHECKOUT,
    ))

    deploy_job.steps.append(WorkflowStep(
        id="deploy",
        name="Deploy",
        action=WorkflowAction.DEPLOY,
        config={"command": "echo 'Deploying to production...'"},
    ))

    return workflow


def _create_deploy_template() -> Workflow:
    """Create a deployment-only workflow."""
    workflow = Workflow(
        name="Deploy",
        description="Manual deployment workflow",
        on=[WorkflowEvent.MANUAL],
    )

    job = WorkflowJob(
        id="deploy",
        name="Deploy to Environment",
        runs_on="ubuntu-latest",
    )

    workflow.jobs.append(job)

    job.steps.append(WorkflowStep(
        id="checkout",
        name="Checkout",
        action=WorkflowAction.CHECKOUT,
    ))

    job.steps.append(WorkflowStep(
        id="setup",
        name="Setup",
        action=WorkflowAction.SETUP_NODE,
        config={"node-version": "20"},
    ))

    job.steps.append(WorkflowStep(
        id="deploy",
        name="Deploy",
        action=WorkflowAction.DEPLOY,
        config={"command": "npm run deploy"},
    ))

    # Add environments
    workflow.environments.append(WorkflowEnvironment(
        name="production",
        url="https://example.com",
        branch="main",
    ))

    return workflow
