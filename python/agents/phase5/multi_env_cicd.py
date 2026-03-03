"""
multi_env_cicd.py — Multi-Environment CI/CD for Phase 5

This module provides multi-environment deployment workflows:
- Environment definitions (dev, staging, prod)
- Environment promotion workflow
- Rollback/revert capabilities
- Status tracking
"""
from __future__ import annotations

import asyncio
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
    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class PromotionDirection(Enum):
    DEV_TO_STAGING = "dev_to_staging"
    STAGING_TO_PROD = "staging_to_prod"
    DEV_TO_PROD = "dev_to_prod"


@dataclass
class EnvironmentConfig:
    """Configuration for a deployment environment."""
    name: Environment
    url: str
    branch: str
    variables: dict[str, str] = field(default_factory=dict)
    secrets: list[str] = field(default_factory=list)  # Secret names (not values)
    auto_promote: bool = False
    requires_approval: bool = True


@dataclass
class Deployment:
    """Represents a single deployment."""
    id: str
    environment: str
    status: DeploymentStatus
    commit_sha: str
    commit_message: str
    branch: str
    deployed_at: datetime
    deployed_by: str
    url: str | None = None
    duration_seconds: int = 0
    error_message: str | None = None
    rollback_from: str | None = None


@dataclass
class RollbackInfo:
    """Information about a rollback."""
    deployment_id: str
    rolled_back_at: datetime
    rolled_back_by: str
    reason: str
    previous_deployment_id: str


class MultiEnvCICD:
    """
    Manages multi-environment CI/CD pipelines.

    Usage:
        cicd = MultiEnvCICD(project_dir=".")
        await cicd.deploy(Environment.DEVELOPMENT, commit_sha="abc123")
        await cicd.promote(Environment.DEVELOPMENT, Environment.STAGING)
        await cicd.rollback(Environment.PRODUCTION, reason="Critical bug")
    """

    def __init__(
        self,
        project_dir: str = ".",
        config_path: str = ".pakalon/environments.json",
    ):
        self.project_dir = Path(project_dir)
        self.config_path = self.project_dir / config_path
        self.deployments: list[Deployment] = []
        self.rollbacks: list[RollbackInfo] = []

        # Default environments
        self.environments: dict[Environment, EnvironmentConfig] = {
            Environment.DEVELOPMENT: EnvironmentConfig(
                name=Environment.DEVELOPMENT,
                url="http://localhost:3000",
                branch="develop",
                requires_approval=False,
            ),
            Environment.STAGING: EnvironmentConfig(
                name=Environment.STAGING,
                url="https://staging.example.com",
                branch="staging",
                requires_approval=True,
            ),
            Environment.PRODUCTION: EnvironmentConfig(
                name=Environment.PRODUCTION,
                url="https://example.com",
                branch="main",
                requires_approval=True,
                auto_promote=False,
            ),
        }

    # -------------------------------------------------------------------------
    # Configuration
    # -------------------------------------------------------------------------

    def load_config(self) -> bool:
        """Load environment configuration from file."""
        if not self.config_path.exists():
            return False

        try:
            with open(self.config_path) as f:
                config = json.load(f)

            for env_name, env_config in config.get("environments", {}).items():
                try:
                    env = Environment(env_name)
                    self.environments[env] = EnvironmentConfig(
                        name=env,
                        url=env_config.get("url", ""),
                        branch=env_config.get("branch", "main"),
                        variables=env_config.get("variables", {}),
                        secrets=env_config.get("secrets", []),
                        auto_promote=env_config.get("auto_promote", False),
                        requires_approval=env_config.get("requires_approval", True),
                    )
                except ValueError:
                    pass

            return True
        except Exception:
            return False

    def save_config(self):
        """Save environment configuration to file."""
        config = {
            "environments": {
                env.value: {
                    "url": cfg.url,
                    "branch": cfg.branch,
                    "variables": cfg.variables,
                    "secrets": cfg.secrets,
                    "auto_promote": cfg.auto_promote,
                    "requires_approval": cfg.requires_approval,
                }
                for env, cfg in self.environments.items()
            }
        }

        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, "w") as f:
            json.dump(config, f, indent=2)

    def configure_environment(
        self,
        env: Environment,
        url: str | None = None,
        branch: str | None = None,
        variables: dict[str, str] | None = None,
        secrets: list[str] | None = None,
    ):
        """Configure an environment."""
        if env not in self.environments:
            self.environments[env] = EnvironmentConfig(
                name=env, url=url or "", branch=branch or "main"
            )

        cfg = self.environments[env]
        if url:
            cfg.url = url
        if branch:
            cfg.branch = branch
        if variables:
            cfg.variables = {**cfg.variables, **variables}
        if secrets:
            cfg.secrets = secrets

        self.save_config()

    # -------------------------------------------------------------------------
    # Deployment
    # -------------------------------------------------------------------------

    async def deploy(
        self,
        env: Environment,
        commit_sha: str,
        branch: str | None = None,
        deployed_by: str = "system",
        commit_message: str = "",
    ) -> Deployment:
        """Deploy to an environment."""
        import uuid

        config = self.environments.get(env)
        if not config:
            raise ValueError(f"Environment {env.value} not configured")

        deployment = Deployment(
            id=str(uuid.uuid4())[:8],
            environment=env.value,
            status=DeploymentStatus.IN_PROGRESS,
            commit_sha=commit_sha,
            commit_message=commit_message,
            branch=branch or config.branch,
            deployed_at=datetime.utcnow(),
            deployed_by=deployed_by,
            url=config.url,
        )

        start_time = datetime.utcnow()

        try:
            # Generate and execute deployment workflow
            workflow = self._generate_workflow(env, commit_sha)
            success = await self._execute_workflow(workflow, env)

            deployment.status = (
                DeploymentStatus.SUCCESS if success else DeploymentStatus.FAILED
            )

            if not success:
                deployment.error_message = "Deployment failed"

        except Exception as e:
            deployment.status = DeploymentStatus.FAILED
            deployment.error_message = str(e)

        deployment.duration_seconds = int(
            (datetime.utcnow() - start_time).total_seconds()
        )

        self.deployments.append(deployment)
        return deployment

    def _generate_workflow(self, env: Environment, commit_sha: str) -> dict:
        """Generate a GitHub Actions workflow for the deployment."""
        config = self.environments[env]

        workflow = {
            "name": f"Deploy to {env.value}",
            "on": {
                "push": {
                    "branches": [config.branch],
                },
                "workflow_dispatch": {
                    "inputs": {
                        "commit_sha": {
                            "description": "Commit SHA to deploy",
                            "required": False,
                        },
                    },
                },
            },
            "jobs": {
                "deploy": {
                    "runs-on": "ubuntu-latest",
                    "environment": {
                        "name": env.value,
                        "url": config.url,
                    },
                    "steps": [
                        {
                            "name": "Checkout code",
                            "uses": "actions/checkout@v4",
                            "with": {
                                "ref": commit_sha,
                            },
                        },
                        {
                            "name": "Setup Node.js",
                            "uses": "actions/setup-node@v4",
                            "with": {
                                "node-version": "20",
                            },
                        },
                        {
                            "name": "Install dependencies",
                            "run": "npm ci",
                        },
                        {
                            "name": "Build application",
                            "run": "npm run build",
                        },
                        {
                            "name": "Deploy to environment",
                            "run": f'echo "Deploying to {env.value} at {config.url}"',
                            # In production, this would be actual deployment commands
                        },
                    ],
                },
            },
        }

        return workflow

    async def _execute_workflow(self, workflow: dict, env: Environment) -> bool:
        """Execute a deployment workflow."""
        # Save workflow to .github/workflows/
        workflow_dir = self.project_dir / ".github" / "workflows"
        workflow_dir.mkdir(parents=True, exist_ok=True)

        workflow_file = workflow_dir / f"deploy-{env.value}.yml"
        import yaml
        with open(workflow_file, "w") as f:
            yaml.dump(workflow, f)

        # In a real implementation, this would:
        # 1. Commit the workflow file
        # 2. Push to the environment branch
        # 3. Wait for GitHub Actions to complete
        # 4. Check the deployment status

        # For now, we simulate success
        return True

    # -------------------------------------------------------------------------
    # Promotion
    # -------------------------------------------------------------------------

    async def promote(
        self,
        from_env: Environment,
        to_env: Environment,
        promoted_by: str = "system",
    ) -> Deployment:
        """Promote a deployment from one environment to another."""
        # Find the latest successful deployment in the source environment
        source_deployments = [
            d for d in self.deployments
            if d.environment == from_env.value and d.status == DeploymentStatus.SUCCESS
        ]

        if not source_deployments:
            raise ValueError(
                f"No successful deployments found in {from_env.value}"
            )

        latest = source_deployments[-1]

        # Create promotion deployment
        return await self.deploy(
            env=to_env,
            commit_sha=latest.commit_sha,
            branch=self.environments[to_env].branch,
            deployed_by=promoted_by,
            commit_message=f"Promoted from {from_env.value}",
        )

    async def auto_promote(
        self,
        from_env: Environment,
        to_env: Environment,
    ) -> bool:
        """Check if auto-promotion is enabled and execute if allowed."""
        source_config = self.environments.get(from_env)
        if not source_config or not source_config.auto_promote:
            return False

        # Check if source has a successful deployment
        source_deployments = [
            d for d in self.deployments
            if d.environment == from_env.value and d.status == DeploymentStatus.SUCCESS
        ]

        if not source_deployments:
            return False

        # Auto-promote
        await self.promote(from_env, to_env)
        return True

    # -------------------------------------------------------------------------
    # Rollback
    # -------------------------------------------------------------------------

    async def rollback(
        self,
        env: Environment,
        reason: str,
        rolled_back_by: str = "system",
    ) -> Deployment | None:
        """Rollback an environment to the previous deployment."""
        env_deployments = [
            d for d in self.deployments
            if d.environment == env.value
        ]

        # Find the last successful deployment (not the current one)
        successful = [
            d for d in env_deployments
            if d.status == DeploymentStatus.SUCCESS
        ]

        if len(successful) < 2:
            return None

        # Rollback to the previous successful deployment
        previous = successful[-2]  # Second-to-last successful
        current = successful[-1] if successful else None

        # Create rollback deployment
        rollback = await self.deploy(
            env=env,
            commit_sha=previous.commit_sha,
            deployed_by=rolled_back_by,
            commit_message=f"Rollback: {reason}",
        )

        rollback.status = DeploymentStatus.ROLLED_BACK
        rollback.rollback_from = current.id if current else None

        # Record rollback info
        rollback_info = RollbackInfo(
            deployment_id=rollback.id,
            rolled_back_at=datetime.utcnow(),
            rolled_back_by=rolled_back_by,
            reason=reason,
            previous_deployment_id=previous.id,
        )
        self.rollbacks.append(rollback_info)

        return rollback

    async def rollback_to(
        self,
        env: Environment,
        deployment_id: str,
        reason: str,
        rolled_back_by: str = "system",
    ) -> Deployment | None:
        """Rollback to a specific deployment."""
        target = next(
            (d for d in self.deployments if d.id == deployment_id), None
        )

        if not target or target.environment != env.value:
            return None

        return await self.deploy(
            env=env,
            commit_sha=target.commit_sha,
            deployed_by=rolled_back_by,
            commit_message=f"Rollback to {deployment_id}: {reason}",
        )

    # -------------------------------------------------------------------------
    # Status and History
    # -------------------------------------------------------------------------

    def get_deployment_history(
        self,
        env: Environment | None = None,
        limit: int = 10,
    ) -> list[Deployment]:
        """Get deployment history."""
        deployments = self.deployments

        if env:
            deployments = [d for d in deployments if d.environment == env.value]

        return deployments[-limit:]

    def get_current_deployment(self, env: Environment) -> Deployment | None:
        """Get the current deployment for an environment."""
        env_deployments = [
            d for d in self.deployments
            if d.environment == env.value
        ]

        if not env_deployments:
            return None

        # Return the most recent deployment (regardless of status)
        return env_deployments[-1]

    def get_status(self, env: Environment) -> dict:
        """Get status of an environment."""
        deployment = self.get_current_deployment(env)
        config = self.environments.get(env)

        return {
            "environment": env.value,
            "configured": config is not None,
            "url": config.url if config else None,
            "branch": config.branch if config else None,
            "current_deployment": {
                "id": deployment.id,
                "status": deployment.status.value,
                "commit_sha": deployment.commit_sha,
                "deployed_at": deployment.deployed_at.isoformat(),
                "duration_seconds": deployment.duration_seconds,
                "error": deployment.error_message,
            }
            if deployment
            else None,
        }

    def get_all_status(self) -> dict:
        """Get status of all environments."""
        return {
            env.value: self.get_status(env) for env in Environment
        }


# -------------------------------------------------------------------------
# CLI Commands
# -------------------------------------------------------------------------

def create_cicd(project_dir: str = ".") -> MultiEnvCICD:
    """Create a MultiEnvCICD instance."""
    cicd = MultiEnvCICD(project_dir)
    cicd.load_config()
    return cicd


async def cmd_cicd_status(env: str | None = None) -> dict:
    """Get CI/CD status."""
    cicd = create_cicd()

    if env:
        try:
            environment = Environment(env)
            return cicd.get_status(environment)
        except ValueError:
            return {"error": f"Invalid environment: {env}"}

    return cicd.get_all_status()


async def cmd_cicd_deploy(
    env: str,
    commit_sha: str,
    branch: str | None = None,
    deployed_by: str = "cli",
) -> dict:
    """Deploy to an environment."""
    cicd = create_cicd()

    try:
        environment = Environment(env)
    except ValueError:
        return {"error": f"Invalid environment: {env}"}

    deployment = await cicd.deploy(
        env=environment,
        commit_sha=commit_sha,
        branch=branch,
        deployed_by=deployed_by,
    )

    return {
        "id": deployment.id,
        "environment": deployment.environment,
        "status": deployment.status.value,
        "commit_sha": deployment.commit_sha,
        "url": deployment.url,
    }


async def cmd_cicd_promote(
    from_env: str,
    to_env: str,
    promoted_by: str = "cli",
) -> dict:
    """Promote from one environment to another."""
    cicd = create_cicd()

    try:
        from_environment = Environment(from_env)
        to_environment = Environment(to_env)
    except ValueError:
        return {"error": "Invalid environment(s)"}

    deployment = await cicd.promote(
        from_env=from_environment,
        to_env=to_environment,
        promoted_by=promoted_by,
    )

    return {
        "id": deployment.id,
        "from": deployment.environment,
        "status": deployment.status.value,
        "commit_sha": deployment.commit_sha,
    }


async def cmd_cicd_rollback(
    env: str,
    reason: str,
    rolled_back_by: str = "cli",
    deployment_id: str | None = None,
) -> dict:
    """Rollback an environment."""
    cicd = create_cicd()

    try:
        environment = Environment(env)
    except ValueError:
        return {"error": f"Invalid environment: {env}"}

    if deployment_id:
        deployment = await cicd.rollback_to(
            env=environment,
            deployment_id=deployment_id,
            reason=reason,
            rolled_back_by=rolled_back_by,
        )
    else:
        deployment = await cicd.rollback(
            env=environment,
            reason=reason,
            rolled_back_by=rolled_back_by,
        )

    if not deployment:
        return {"error": "No previous deployment to rollback to"}

    return {
        "id": deployment.id,
        "environment": deployment.environment,
        "status": deployment.status.value,
        "commit_sha": deployment.commit_sha,
    }


async def cmd_cicd_configure(
    env: str,
    url: str | None = None,
    branch: str | None = None,
    auto_promote: bool | None = None,
) -> dict:
    """Configure an environment."""
    cicd = create_cicd()

    try:
        environment = Environment(env)
    except ValueError:
        return {"error": f"Invalid environment: {env}"}

    if url:
        cicd.configure_environment(environment, url=url)
    if branch:
        cicd.configure_environment(environment, branch=branch)

    config = cicd.environments.get(environment)
    if auto_promote is not None and config:
        config.auto_promote = auto_promote
        cicd.save_config()

    return {
        "status": "configured",
        "environment": env,
        "url": config.url if config else None,
        "branch": config.branch if config else None,
    }
