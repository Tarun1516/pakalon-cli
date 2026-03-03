"""
ci_cd_environments.py — Multi-Environment CI/CD Management for Phase 5

This module provides:
- Environment configuration (dev/staging/prod)
- Deployment workflow generation
- Rollback/revert capabilities
- Environment promotion pipelines
"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any


class Environment(Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class DeploymentStatus(Enum):
    PENDING = "pending"
    DEPLOYING = "deploying"
    SUCCESS = "success"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


@dataclass
class EnvironmentConfig:
    """Configuration for a deployment environment."""
    name: str
    api_url: str
    web_url: str
    database_url: str | None = None
    redis_url: str | None = None
    secrets: dict[str, str] = field(default_factory=dict)
    variables: dict[str, str] = field(default_factory=dict)
    auto_approve: bool = False
    requires_tests: bool = True


@dataclass
class Deployment:
    """Represents a single deployment."""
    id: str
    environment: str
    version: str
    status: DeploymentStatus
    created_at: datetime
    completed_at: datetime | None = None
    commit_sha: str | None = None
    commit_message: str | None = None
    deployed_by: str | None = None
    rollback_from: str | None = None
    error_message: str | None = None


class CICDEnvironmentManager:
    """
    Manages multi-environment CI/CD pipelines.

    Usage:
        manager = CICDEnvironmentManager(project_dir=".")
        await manager.deploy(Environment.STAGING)
        await manager.rollback(Environment.STAGING)
    """

    # Default environment configurations
    DEFAULT_CONFIGS = {
        Environment.DEVELOPMENT: EnvironmentConfig(
            name="development",
            api_url="http://localhost:3001",
            web_url="http://localhost:3000",
            database_url=os.environ.get("DEV_DATABASE_URL"),
            redis_url=os.environ.get("DEV_REDIS_URL"),
            auto_approve=True,
            requires_tests=False,
        ),
        Environment.STAGING: EnvironmentConfig(
            name="staging",
            api_url="https://staging-api.example.com",
            web_url="https://staging.example.com",
            database_url=os.environ.get("STAGING_DATABASE_URL"),
            redis_url=os.environ.get("STAGING_REDIS_URL"),
            auto_approve=False,
            requires_tests=True,
        ),
        Environment.PRODUCTION: EnvironmentConfig(
            name="production",
            api_url="https://api.example.com",
            web_url="https://example.com",
            database_url=os.environ.get("PROD_DATABASE_URL"),
            redis_url=os.environ.get("PROD_REDIS_URL"),
            auto_approve=False,
            requires_tests=True,
        ),
    }

    def __init__(self, project_dir: str = "."):
        self.project_dir = Path(project_dir)
        self.config_dir = self.project_dir / ".pakalon" / "ci-cd"
        self.config_file = self.config_dir / "environments.json"
        self.deployments_file = self.config_dir / "deployments.json"
        self.workflows_dir = self.project_dir / ".github" / "workflows"

        self.environments: dict[str, EnvironmentConfig] = {}
        self.deployments: list[Deployment] = []

        self._load_config()

    def _load_config(self):
        """Load environment configurations."""
        if self.config_file.exists():
            try:
                with open(self.config_file) as f:
                    data = json.load(f)
                    for name, config in data.items():
                        self.environments[name] = EnvironmentConfig(**config)
            except Exception:
                pass

        # Load default configs for missing environments
        for env in Environment:
            if env.value not in self.environments:
                self.environments[env.value] = self.DEFAULT_CONFIGS[env]

    def _save_config(self):
        """Save environment configurations."""
        self.config_dir.mkdir(parents=True, exist_ok=True)
        data = {
            name: {
                "name": config.name,
                "api_url": config.api_url,
                "web_url": config.web_url,
                "database_url": config.database_url,
                "redis_url": config.redis_url,
                "secrets": config.secrets,
                "variables": config.variables,
                "auto_approve": config.auto_approve,
                "requires_tests": config.requires_tests,
            }
            for name, config in self.environments.items()
        }
        with open(self.config_file, "w") as f:
            json.dump(data, f, indent=2)

    def _load_deployments(self):
        """Load deployment history."""
        if self.deployments_file.exists():
            try:
                with open(self.deployments_file) as f:
                    data = json.load(f)
                    self.deployments = [
                        Deployment(
                            id=d["id"],
                            environment=d["environment"],
                            version=d["version"],
                            status=DeploymentStatus(d["status"]),
                            created_at=datetime.fromisoformat(d["created_at"]),
                            completed_at=datetime.fromisoformat(d["completed_at"]) if d.get("completed_at") else None,
                            commit_sha=d.get("commit_sha"),
                            commit_message=d.get("commit_message"),
                            deployed_by=d.get("deployed_by"),
                            rollback_from=d.get("rollback_from"),
                            error_message=d.get("error_message"),
                        )
                        for d in data
                    ]
            except Exception:
                pass

    def _save_deployments(self):
        """Save deployment history."""
        self.config_dir.mkdir(parents=True, exist_ok=True)
        data = [
            {
                "id": d.id,
                "environment": d.environment,
                "version": d.version,
                "status": d.status.value,
                "created_at": d.created_at.isoformat(),
                "completed_at": d.completed_at.isoformat() if d.completed_at else None,
                "commit_sha": d.commit_sha,
                "commit_message": d.commit_message,
                "deployed_by": d.deployed_by,
                "rollback_from": d.rollback_from,
                "error_message": d.error_message,
            }
            for d in self.deployments
        ]
        with open(self.deployments_file, "w") as f:
            json.dump(data, f, indent=2)

    # -------------------------------------------------------------------------
    # Configuration Methods
    # -------------------------------------------------------------------------

    def get_environment(self, name: str) -> EnvironmentConfig | None:
        """Get environment configuration."""
        return self.environments.get(name)

    def update_environment(self, name: str, config: EnvironmentConfig):
        """Update environment configuration."""
        self.environments[name] = config
        self._save_config()

    def add_secret(self, env_name: str, key: str, value: str):
        """Add a secret to an environment."""
        if env_name in self.environments:
            self.environments[env_name].secrets[key] = value
            self._save_config()

    # -------------------------------------------------------------------------
    # Deployment Methods
    # -------------------------------------------------------------------------

    async def deploy(
        self,
        environment: Environment,
        version: str = "latest",
        commit_sha: str | None = None,
        deployed_by: str | None = None,
    ) -> Deployment:
        """
        Deploy to an environment.
        """
        import uuid

        env_config = self.environments.get(environment.value)
        if not env_config:
            raise ValueError(f"Unknown environment: {environment.value}")

        deployment = Deployment(
            id=str(uuid.uuid4())[:8],
            environment=environment.value,
            version=version,
            status=DeploymentStatus.PENDING,
            created_at=datetime.utcnow(),
            commit_sha=commit_sha,
            deployed_by=deployed_by,
        )

        self.deployments.append(deployment)
        self._save_deployments()

        # Simulate deployment (in real implementation, this would call actual deployment tools)
        deployment.status = DeploymentStatus.DEPLOYING
        self._save_deployments()

        try:
            # In a real implementation:
            # 1. Run tests if required
            # 2. Build the application
            # 3. Deploy to the target environment
            # 4. Verify deployment

            deployment.status = DeploymentStatus.SUCCESS
            deployment.completed_at = datetime.utcnow()
        except Exception as e:
            deployment.status = DeploymentStatus.FAILED
            deployment.completed_at = datetime.utcnow()
            deployment.error_message = str(e)

        self._save_deployments()
        return deployment

    async def rollback(
        self,
        environment: Environment,
        target_version: str | None = None,
        deployed_by: str | None = None,
    ) -> Deployment | None:
        """
        Rollback to a previous version.
        """
        # Find the last successful deployment
        env_deployments = [
            d for d in reversed(self.deployments)
            if d.environment == environment.value and d.status == DeploymentStatus.SUCCESS
        ]

        if not env_deployments:
            return None

        if target_version:
            target = next((d for d in env_deployments if d.version == target_version), None)
        else:
            # Rollback to previous version
            target = env_deployments[1] if len(env_deployments) > 1 else env_deployments[0]

        if not target:
            return None

        # Create rollback deployment
        rollback = await self.deploy(
            environment,
            version=target.version,
            commit_sha=target.commit_sha,
            deployed_by=deployed_by,
        )
        rollback.rollback_from = target.id
        rollback.status = DeploymentStatus.ROLLED_BACK
        self._save_deployments()

        return rollback

    async def promote(
        self,
        from_env: Environment,
        to_env: Environment,
        deployed_by: str | None = None,
    ) -> Deployment:
        """
        Promote a deployment from one environment to another.
        """
        # Get the last successful deployment from source
        source_deployments = [
            d for d in reversed(self.deployments)
            if d.environment == from_env.value and d.status == DeploymentStatus.SUCCESS
        ]

        if not source_deployments:
            raise ValueError(f"No successful deployments in {from_env.value}")

        source = source_deployments[0]

        # Deploy to target environment
        return await self.deploy(
            to_env,
            version=source.version,
            commit_sha=source.commit_sha,
            deployed_by=deployed_by,
        )

    # -------------------------------------------------------------------------
    # GitHub Actions Workflow Generation
    # -------------------------------------------------------------------------

    def generate_workflows(self):
        """Generate GitHub Actions workflows for CI/CD."""
        self.workflows_dir.mkdir(parents=True, exist_ok=True)

        # Main CI workflow
        ci_workflow = {
            "name": "CI",
            "on": {
                "push": {"branches": ["main", "develop"]},
                "pull_request": {"branches": ["main"]},
            },
            "jobs": {
                "test": {
                    "runs-on": "ubuntu-latest",
                    "steps": [
                        {"uses": "actions/checkout@v4"},
                        {"uses": "actions/setup-node@v4", "with": {"node-version": "20"}},
                        {"run": "npm ci"},
                        {"run": "npm test"},
                    ],
                },
                "build": {
                    "runs-on": "ubuntu-latest",
                    "needs": ["test"],
                    "steps": [
                        {"uses": "actions/checkout@v4"},
                        {"uses": "actions/setup-node@v4", "with": {"node-version": "20"}},
                        {"run": "npm ci"},
                        {"run": "npm run build"},
                    ],
                },
            },
        }

        with open(self.workflows_dir / "ci.yml", "w") as f:
            json.dump(ci_workflow, f, indent=2)

        # Deploy workflow with environments
        deploy_workflow = {
            "name": "Deploy",
            "on": {
                "workflow_dispatch": {
                    "inputs": {
                        "environment": {
                            "description": "Deployment environment",
                            "required": True,
                            "type": "choice",
                            "options": ["development", "staging", "production"],
                        },
                    },
                },
            },
            "jobs": {
                "deploy": {
                    "runs-on": "ubuntu-latest",
                    "environment": {"name": "${{ github.event.inputs.environment }}"},
                    "steps": [
                        {"uses": "actions/checkout@v4"},
                        {"run": "echo 'Deploying to ${{ github.event.inputs.environment }}'"},
                        # Add actual deployment steps here
                    ],
                },
            },
        }

        with open(self.workflows_dir / "deploy.yml", "w") as f:
            json.dump(deploy_workflow, f, indent=2)

    # -------------------------------------------------------------------------
    # Status and History
    # -------------------------------------------------------------------------

    def get_deployment_history(
        self,
        environment: str | None = None,
        limit: int = 10,
    ) -> list[Deployment]:
        """Get deployment history."""
        deployments = self.deployments
        if environment:
            deployments = [d for d in deployments if d.environment == environment]
        return deployments[-limit:]

    def get_current_deployment(self, environment: str) -> Deployment | None:
        """Get the current deployment for an environment."""
        env_deployments = [
            d for d in reversed(self.deployments)
            if d.environment == environment and d.status == DeploymentStatus.SUCCESS
        ]
        return env_deployments[0] if env_deployments else None


# -------------------------------------------------------------------------
# CLI Commands
# -------------------------------------------------------------------------

async def cmd_cicd_status(environment: str | None = None) -> dict:
    """Get CI/CD status for environments."""
    manager = CICDEnvironmentManager()

    if environment:
        env_config = manager.get_environment(environment)
        current = manager.get_current_deployment(environment)
        history = manager.get_deployment_history(environment, limit=5)

        return {
            "environment": environment,
            "config": {
                "api_url": env_config.api_url if env_config else None,
                "web_url": env_config.web_url if env_config else None,
                "requires_tests": env_config.requires_tests if env_config else None,
            },
            "current_deployment": {
                "version": current.version,
                "commit_sha": current.commit_sha,
                "deployed_at": current.completed_at.isoformat() if current.completed_at else None,
            } if current else None,
            "recent_deployments": [
                {
                    "id": d.id,
                    "version": d.version,
                    "status": d.status.value,
                    "created_at": d.created_at.isoformat(),
                }
                for d in history
            ],
        }

    # Return all environments
    return {
        "environments": {
            name: {
                "api_url": config.api_url,
                "web_url": config.web_url,
                "current_version": manager.get_current_deployment(name).version if manager.get_current_deployment(name) else None,
            }
            for name, config in manager.environments.items()
        }
    }


async def cmd_cicd_deploy(environment: str, version: str = "latest") -> dict:
    """Deploy to an environment."""
    manager = CICDEnvironmentManager()

    try:
        env = Environment(environment)
    except ValueError:
        return {"error": f"Invalid environment: {environment}"}

    deployment = await manager.deploy(env, version=version)

    return {
        "status": "success" if deployment.status == DeploymentStatus.SUCCESS else "failed",
        "deployment": {
            "id": deployment.id,
            "environment": deployment.environment,
            "version": deployment.version,
            "status": deployment.status.value,
            "created_at": deployment.created_at.isoformat(),
            "error": deployment.error_message,
        },
    }


async def cmd_cicd_rollback(environment: str, target_version: str | None = None) -> dict:
    """Rollback an environment."""
    manager = CICDEnvironmentManager()

    try:
        env = Environment(environment)
    except ValueError:
        return {"error": f"Invalid environment: {environment}"}

    deployment = await manager.rollback(env, target_version=target_version)

    if not deployment:
        return {"error": "No deployment to rollback to"}

    return {
        "status": "success",
        "deployment": {
            "id": deployment.id,
            "environment": deployment.environment,
            "version": deployment.version,
            "status": deployment.status.value,
            "rolled_back_from": deployment.rollback_from,
        },
    }


async def cmd_cicd_promote(from_env: str, to_env: str) -> dict:
    """Promote from one environment to another."""
    manager = CICDEnvironmentManager()

    try:
        from_environment = Environment(from_env)
        to_environment = Environment(to_env)
    except ValueError as e:
        return {"error": str(e)}

    deployment = await manager.promote(from_environment, to_environment)

    return {
        "status": "success",
        "deployment": {
            "id": deployment.id,
            "from": from_env,
            "to": to_env,
            "version": deployment.version,
            "status": deployment.status.value,
        },
    }
