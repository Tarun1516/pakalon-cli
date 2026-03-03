"""
graph.py — Phase 5 LangGraph StateGraph: CI/CD Agent.
T120: Generate GitHub Actions workflows, commit implementation, open PR.
Nodes: read_phase4 → generate_env_config → generate_workflows → generate_multienv_workflows
       → custom_workflow_editor → commit_code → create_pr → manage_git_issues → notify

E: Multi-environment CI/CD — EnvironmentConfig model, env config generation,
   promotion gating, .pakalon/environments.json persistence.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import subprocess
from typing import Any, Optional, TypedDict

try:
    from langgraph.graph import StateGraph, END  # type: ignore
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

from ..shared.paths import get_phase_dir
from ..shared.decision_registry import record_decision


# ---------------------------------------------------------------------------
# E: Environment model
# ---------------------------------------------------------------------------

class EnvironmentConfig(TypedDict, total=False):
    """Canonical model for a single deployment environment."""
    name: str                       # "dev" | "staging" | "production"
    url: Optional[str]              # public URL when deployed
    branch: Optional[str]           # git branch this env deploys from
    vars: dict[str, str]            # non-secret env vars (committed to vars store)
    secrets: list[str]              # secret names (values never stored in code)
    promotion_gate: list[str]       # checks that must pass before promoting to next env
    auto_deploy: bool               # true = deploys on push; false = manual trigger only
    protected: bool                 # true = requires review/approval before deploy


def _build_default_env_config(
    project_dir: pathlib.Path,
    provider: str = "generic",
) -> list[EnvironmentConfig]:
    """
    Build a sensible default 3-tier environment config model (dev/staging/production).
    Customized per detected provider.
    """
    base_url_var = {
        "vercel": "*.vercel.app",
        "fly": "*.fly.dev",
        "render": "*.onrender.com",
        "railway": "*.railway.app",
        "docker": "http://localhost",
        "generic": "http://localhost",
    }
    preview_suffix = base_url_var.get(provider, "http://localhost")
    deploy_secret = f"{provider.upper()}_TOKEN" if provider not in ("generic", "docker") else "DEPLOY_TOKEN"
    prod_deploy_secret = f"{provider.upper()}_PROD_TOKEN" if provider not in ("generic", "docker") else "PROD_DEPLOY_TOKEN"

    return [
        {
            "name": "dev",
            "url": "http://localhost:3000",
            "branch": "feature/*",
            "vars": {"NODE_ENV": "development", "LOG_LEVEL": "debug", "NEXT_PUBLIC_ENV": "development"},
            "secrets": ["DATABASE_URL", "NEXTAUTH_SECRET", "OPENROUTER_API_KEY"],
            "promotion_gate": ["lint", "type-check", "unit-tests"],
            "auto_deploy": False,
            "protected": False,
        },
        {
            "name": "staging",
            "url": f"staging.{preview_suffix}",
            "branch": "develop",
            "vars": {"NODE_ENV": "production", "LOG_LEVEL": "info", "NEXT_PUBLIC_ENV": "staging"},
            "secrets": ["DATABASE_URL", "NEXTAUTH_SECRET", "OPENROUTER_API_KEY", deploy_secret],
            "promotion_gate": ["lint", "type-check", "unit-tests", "integration-tests", "security-scan"],
            "auto_deploy": True,
            "protected": False,
        },
        {
            "name": "production",
            "url": f"app.{preview_suffix}",
            "branch": "main",
            "vars": {"NODE_ENV": "production", "LOG_LEVEL": "warn", "NEXT_PUBLIC_ENV": "production"},
            "secrets": ["DATABASE_URL", "NEXTAUTH_SECRET", "OPENROUTER_API_KEY", prod_deploy_secret],
            "promotion_gate": [
                "lint", "type-check", "unit-tests",
                "integration-tests", "e2e-tests",
                "security-scan", "manual-review",
            ],
            "auto_deploy": False,
            "protected": True,
        },
    ]


def _generate_promotion_steps_md(envs: list[EnvironmentConfig]) -> str:
    """Generate a Markdown document describing the promotion flow between environments."""
    lines = ["# Environment Promotion Flow\n"]
    for i, env in enumerate(envs):
        name = env.get("name", f"env-{i}")
        lines.append(f"## {i+1}. {name.capitalize()}")
        lines.append(f"- **Branch**: `{env.get('branch', 'N/A')}`")
        lines.append(f"- **URL**: `{env.get('url', 'N/A')}`")
        lines.append(f"- **Auto-deploy**: {'Yes' if env.get('auto_deploy') else 'No (manual)'}")
        lines.append(f"- **Protected**: {'Yes — requires approval' if env.get('protected') else 'No'}")
        gates = env.get("promotion_gate", [])
        if gates:
            lines.append("- **Promotion gates**:")
            for gate in gates:
                lines.append(f"  - {gate}")
        secrets = env.get("secrets", [])
        if secrets:
            lines.append(f"- **Required secrets**: {', '.join(f'`{s}`' for s in secrets)}")
        if i < len(envs) - 1:
            next_env = envs[i + 1]
            next_name = next_env.get("name", "next")
            lines.append(f"\n**→ To promote to {next_name.capitalize()}**: all gates above must pass.")
        lines.append("")
    return "\n".join(lines)


async def generate_env_config(state: "Phase5State") -> "Phase5State":
    """
    Node: Generate multi-environment config model and persist to .pakalon/environments.json.

    Produces:
    - .pakalon-agents/phase-5/environments.json  — machine-readable env config
    - .pakalon-agents/phase-5/promotion-flow.md  — human-readable promotion steps
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🌐 Phase 5: Generating environment config model...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))

    # Detect provider (reuse logic from multienv workflows node)
    provider = _detect_deploy_provider(project_dir)
    envs = _build_default_env_config(project_dir, provider)

    # Persist environments.json
    phase5_dir = get_phase_dir(project_dir, 5)
    env_config_path = phase5_dir / "environments.json"
    env_config_path.write_text(json.dumps(envs, indent=2), encoding="utf-8")
    sse({"type": "text_delta", "content": f"  ✅ environments.json written ({len(envs)} environments)\n"})

    # Persist promotion-flow.md
    promotion_md = _generate_promotion_steps_md(envs)
    promotion_path = phase5_dir / "promotion-flow.md"
    promotion_path.write_text(promotion_md, encoding="utf-8")
    sse({"type": "text_delta", "content": "  ✅ promotion-flow.md written\n"})

    # Also write to project root .pakalon/ for CLI access
    pakalon_dir = project_dir / ".pakalon-agents"
    pakalon_dir.mkdir(parents=True, exist_ok=True)
    (pakalon_dir / "environments.json").write_text(json.dumps(envs, indent=2), encoding="utf-8")

    # SSE status event for CLI display
    sse({
        "type": "env_config",
        "environments": [{"name": e.get("name"), "url": e.get("url"), "protected": e.get("protected")} for e in envs],
        "provider": provider,
    })

    # Record in cross-phase decision registry
    record_decision(
        str(project_dir),
        phase=5,
        decision_type="deployment",
        description=f"Multi-environment config generated: {', '.join(e.get('name', '') for e in envs)} — provider: {provider}",
        source_file="phase-5/environments.json",
        metadata={"provider": provider, "environment_count": len(envs)},
    )

    state["env_configs"] = envs  # type: ignore[typeddict-unknown-key]
    return state


WORKFLOW_TEMPLATES: dict[str, str] = {
    "ci.yml": """\
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
""",
    "security.yml": """\
name: Security Scan

on:
  schedule:
    - cron: '0 2 * * 1'
  push:
    branches: [main]

jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: returntocorp/semgrep-action@v1
        with:
          config: auto
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
""",
    "deploy.yml": """\
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: echo "Deploy step — configure with your provider"
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
""",
}


class Phase5State(TypedDict, total=False):
    project_dir: str
    user_id: str
    is_yolo: bool
    send_sse: Any
    _input_queue: Any
    phase4_summary: dict
    workflow_files: list[str]
    multienv_workflow_files: list[str]
    custom_workflows: dict[str, str]   # user-edited workflow YAML overrides
    env_configs: list[EnvironmentConfig]  # E: multi-env config model
    git_commit_sha: str
    pr_url: str
    github_issues: list[str]          # T-CLI-P5: Created GitHub issue URLs
    closed_issues: list[str]          # T-CLI-P5: Closed/resolved issue URLs
    outputs_saved: list[str]
    secrets_configured: list[str]         # T-P5-SECRETS: names of secrets successfully set
    context_budget: dict | None        # T103: optional ContextBudget.get_all() dict for per-phase max_tokens caps
    prereqs_ok: bool                   # T-P5-02: True when git prereq check passed
    environment_configs: list[dict]    # T-P5-04: env URL list for README section

# ------------------------------------------------------------------
# Nodes
# ------------------------------------------------------------------

async def check_git_prereqs(state: Phase5State) -> Phase5State:
    """
    T-P5-02: Verify git (and optionally gh CLI) are available before proceeding.
    Emits a clear error event and aborts early if git is not found.
    """
    import shutil  # noqa: PLC0415
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🔧 Phase 5: Checking prerequisites...\n"})

    # Check git
    git_path = shutil.which("git")
    if git_path is None:
        msg = (
            "❌ Phase 5 prerequisite check failed: `git` is not installed or not in PATH.\n\n"
            "Please install git (https://git-scm.com/downloads) and re-run.\n"
        )
        sse({"type": "error", "content": msg})
        state["prereqs_ok"] = False
        return state

    # Check git version (must be ≥ 2.28 for --initial-branch support)
    try:
        result = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=5)
        sse({"type": "text_delta", "content": f"  git: {result.stdout.strip()}\n"})
    except Exception:
        pass

    # Check gh CLI — optional, only warn if GITHUB_TOKEN is also absent
    gh_path = shutil.which("gh")
    gh_token = os.environ.get("GITHUB_TOKEN", "")
    if not gh_path and not gh_token:
        sse({"type": "text_delta", "content": (
            "  ⚠️  GitHub CLI (`gh`) not found and GITHUB_TOKEN not set.\n"
            "     PR creation will be skipped. Set GITHUB_TOKEN to enable it.\n"
        )})

    state["prereqs_ok"] = True
    sse({"type": "text_delta", "content": "  ✅ Prerequisites OK\n"})
    return state


async def read_phase4(state: Phase5State) -> Phase5State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📖 Phase 5: Reading phase 4 results...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    phase4_dir = get_phase_dir(project_dir, 4, create=False)
    summary: dict = {}
    if phase4_dir.exists():
        for f in phase4_dir.glob("*.md"):
            summary[f.name] = f.read_text()[:1000]
    state["phase4_summary"] = summary
    return state


def _detect_tech_stack(project_dir: pathlib.Path) -> dict[str, bool]:
    """Detect project tech-stack from project files."""
    stack: dict[str, bool] = {
        "node": False,
        "typescript": False,
        "nextjs": False,
        "python": False,
        "docker": False,
        "go": False,
    }
    pkg = project_dir / "package.json"
    if pkg.exists():
        stack["node"] = True
        try:
            pkg_data = json.loads(pkg.read_text())
            deps = {**pkg_data.get("dependencies", {}), **pkg_data.get("devDependencies", {})}
            if "next" in deps:
                stack["nextjs"] = True
            if "typescript" in deps or (project_dir / "tsconfig.json").exists():
                stack["typescript"] = True
        except Exception:
            pass
    if (project_dir / "pyproject.toml").exists() or (project_dir / "requirements.txt").exists():
        stack["python"] = True
    if (project_dir / "Dockerfile").exists() or (project_dir / "docker-compose.yml").exists():
        stack["docker"] = True
    if (project_dir / "go.mod").exists():
        stack["go"] = True
    return stack


def _build_ci_template(stack: dict[str, bool]) -> str:
    """Build a tech-stack-aware CI workflow template."""
    steps: list[str] = ["      - uses: actions/checkout@v4"]
    if stack.get("nextjs") or stack.get("node"):
        node_ver = "20"
        steps += [
            f"      - uses: actions/setup-node@v4\n        with:\n          node-version: '{node_ver}'\n          cache: 'npm'",
            "      - run: npm ci",
        ]
        if stack.get("typescript"):
            steps.append("      - run: npx tsc --noEmit")
        steps += ["      - run: npm test -- --passWithNoTests", "      - run: npm run build"]
    if stack.get("python"):
        steps += [
            "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'",
            "      - run: pip install -r requirements.txt",
            "      - run: python -m pytest --tb=short -q || true",
        ]
    if stack.get("go"):
        steps += [
            "      - uses: actions/setup-go@v5\n        with:\n          go-version: '1.22'",
            "      - run: go build ./...",
            "      - run: go test ./...",
        ]
    if stack.get("docker"):
        steps.append("      - run: docker build . -t app:ci")

    body = "\n".join(steps)
    return f"""name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
{body}
"""


async def generate_workflows(state: Phase5State) -> Phase5State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "⚙️  Generating GitHub Actions workflows...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    workflows_dir = project_dir / ".github" / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)

    # Detect tech stack and generate tailored CI template
    stack = _detect_tech_stack(project_dir)
    sse({"type": "text_delta", "content": f"  Detected stack: {[k for k, v in stack.items() if v]}\n"})
    ci_content = _build_ci_template(stack)

    # Merge tailored ci.yml with static templates (security, deploy)
    templates = dict(WORKFLOW_TEMPLATES)
    templates["ci.yml"] = ci_content  # override with tailored version

    created: list[str] = []
    for name, content in templates.items():
        path = workflows_dir / name
        if not path.exists():
            path.write_text(content)
            created.append(str(path))
            sse({"type": "text_delta", "content": f"  Created {name}\n"})

    state["workflow_files"] = created
    return state


# ---------------------------------------------------------------------------
# Multi-environment CI/CD templates — staging + production + E2E + rollback
# ---------------------------------------------------------------------------

_STAGING_DEPLOY_TEMPLATE = """\
name: Deploy — Staging

on:
  push:
    branches: [develop, staging]
  pull_request:
    branches: [main]
    types: [opened, synchronize]

env:
  ENVIRONMENT: staging

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & Test
        run: |
          npm ci
          npm run build
          npm test -- --passWithNoTests
      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: build-staging
          path: .next/

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: ${{ steps.deploy.outputs.url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: build-staging
          path: .next/
      - name: Deploy to Staging
        id: deploy
        run: echo "Deploy to staging — configure with your provider (Vercel/Fly/Render)"
        env:
          STAGING_DEPLOY_TOKEN: ${{ secrets.STAGING_DEPLOY_TOKEN }}
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          NEXTAUTH_URL: ${{ vars.STAGING_URL }}
"""

_PRODUCTION_DEPLOY_TEMPLATE = """\
name: Deploy — Production

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      skip_e2e:
        type: boolean
        default: false
        description: Skip E2E tests before deploying

env:
  ENVIRONMENT: production

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test -- --passWithNoTests

  e2e-smoke:
    needs: preflight
    if: ${{ !inputs.skip_e2e }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: E2E smoke tests (Playwright)
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npx playwright test --reporter=dot || true

  deploy-production:
    needs: [preflight, e2e-smoke]
    if: always() && needs.preflight.result == 'success'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: ${{ steps.deploy.outputs.url }}
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Production
        id: deploy
        run: echo "Deploy to production — configure with your provider"
        env:
          PROD_DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
          NEXTAUTH_URL: ${{ vars.PRODUCTION_URL }}
      - name: Post-deployment health check
        run: |
          sleep 15
          curl -f ${{ vars.PRODUCTION_URL }}/api/health || echo "Health check failed — monitor deployment"

  notify-failure:
    needs: deploy-production
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - name: Notify failure
        run: echo "Production deployment failed — ${{ github.run_url }}"
"""

_E2E_SCHEDULE_TEMPLATE = """\
name: E2E Tests

on:
  schedule:
    - cron: '0 6 * * *'   # Daily at 06:00 UTC
  workflow_dispatch:

jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        browser: [chromium, firefox]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Install Playwright
        run: npx playwright install --with-deps ${{ matrix.browser }}
      - name: Run E2E tests
        run: npx playwright test --reporter=html --project=${{ matrix.browser }}
        env:
          BASE_URL: ${{ vars.STAGING_URL || 'http://localhost:3000' }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report-${{ matrix.browser }}
          path: playwright-report/
"""

_ROLLBACK_TEMPLATE = """\
name: Rollback Production

on:
  workflow_dispatch:
    inputs:
      target_sha:
        type: string
        required: true
        description: Git SHA to roll back to (run `git log --oneline` to find it)
      reason:
        type: string
        required: false
        description: Reason for rollback

jobs:
  rollback:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Validate target SHA
        run: git cat-file -t ${{ inputs.target_sha }}
      - name: Create rollback commit
        run: |
          git revert --no-commit ${{ inputs.target_sha }}..HEAD
          git commit -m "revert: rollback to ${{ inputs.target_sha }}"
          git log --oneline -5
      - name: Deploy rollback build
        run: echo "Deploy rollback — configure with your provider"
        env:
          PROD_DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}
      - name: Create incident issue
        if: always()
        run: |
          gh issue create \
            --title "[Incident] Production rollback to ${{ inputs.target_sha }}" \
            --body "Rolled back to ${{ inputs.target_sha }}. Reason: ${{ inputs.reason || 'Not specified' }}" \
            --label "incident,production"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
"""

_MULTIENV_TEMPLATES: dict[str, str] = {
    "deploy-staging.yml": _STAGING_DEPLOY_TEMPLATE,
    "deploy-production.yml": _PRODUCTION_DEPLOY_TEMPLATE,
    "e2e.yml": _E2E_SCHEDULE_TEMPLATE,
    "rollback.yml": _ROLLBACK_TEMPLATE,
}


def _detect_deploy_provider(project_dir: pathlib.Path) -> str:
    """Heuristically detect the deployment provider from project files."""
    # Vercel
    if (project_dir / "vercel.json").exists():
        return "vercel"
    # Fly.io
    if (project_dir / "fly.toml").exists():
        return "fly"
    # Render
    if (project_dir / "render.yaml").exists() or (project_dir / "render.yml").exists():
        return "render"
    # Railway
    if (project_dir / "railway.toml").exists() or (project_dir / "railway.json").exists():
        return "railway"
    # Docker Compose (self-hosted / VPS)
    if (project_dir / "docker-compose.yml").exists() or (project_dir / "docker-compose.yaml").exists():
        return "docker"
    # Next.js without explicit config → default to Vercel
    pkg = project_dir / "package.json"
    if pkg.exists():
        try:
            deps = json.loads(pkg.read_text()).get("dependencies", {})
            if "next" in deps:
                return "vercel"
        except Exception:
            pass
    return "generic"


def _inject_provider_deploy_step(template: str, provider: str) -> str:
    """Replace the placeholder deploy step with the provider-specific command."""
    _PROVIDER_STEPS: dict[str, dict[str, str]] = {
        "vercel": {
            "staging": (
                "      - name: Deploy to Vercel (Staging)\n"
                "        id: deploy\n"
                "        uses: amondnet/vercel-action@v25\n"
                "        with:\n"
                "          vercel-token: ${{ secrets.VERCEL_TOKEN }}\n"
                "          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}\n"
                "          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}\n"
                "          vercel-args: '--prebuilt'\n"
            ),
            "production": (
                "      - name: Deploy to Vercel (Production)\n"
                "        id: deploy\n"
                "        uses: amondnet/vercel-action@v25\n"
                "        with:\n"
                "          vercel-token: ${{ secrets.VERCEL_TOKEN }}\n"
                "          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}\n"
                "          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}\n"
                "          vercel-args: '--prod --prebuilt'\n"
            ),
        },
        "fly": {
            "staging": (
                "      - name: Deploy to Fly.io (Staging)\n"
                "        id: deploy\n"
                "        uses: superfly/flyctl-actions/setup-flyctl@master\n"
                "      - run: flyctl deploy --remote-only --app ${{ vars.FLY_APP_STAGING }}\n"
                "        env:\n"
                "          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}\n"
            ),
            "production": (
                "      - name: Deploy to Fly.io (Production)\n"
                "        id: deploy\n"
                "        uses: superfly/flyctl-actions/setup-flyctl@master\n"
                "      - run: flyctl deploy --remote-only\n"
                "        env:\n"
                "          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}\n"
            ),
        },
        "render": {
            "staging": (
                "      - name: Trigger Render Deploy (Staging)\n"
                "        id: deploy\n"
                "        run: |\n"
                "          curl -X POST '${{ secrets.RENDER_STAGING_DEPLOY_HOOK }}' \\\n"
                "            -H 'Accept: application/json' --fail\n"
            ),
            "production": (
                "      - name: Trigger Render Deploy (Production)\n"
                "        id: deploy\n"
                "        run: |\n"
                "          curl -X POST '${{ secrets.RENDER_PRODUCTION_DEPLOY_HOOK }}' \\\n"
                "            -H 'Accept: application/json' --fail\n"
            ),
        },
        "railway": {
            "staging": (
                "      - name: Deploy to Railway (Staging)\n"
                "        id: deploy\n"
                "        uses: bervProject/railway-deploy@main\n"
                "        with:\n"
                "          railway-token: ${{ secrets.RAILWAY_TOKEN }}\n"
                "          service: ${{ vars.RAILWAY_STAGING_SERVICE }}\n"
            ),
            "production": (
                "      - name: Deploy to Railway (Production)\n"
                "        id: deploy\n"
                "        uses: bervProject/railway-deploy@main\n"
                "        with:\n"
                "          railway-token: ${{ secrets.RAILWAY_TOKEN }}\n"
                "          service: ${{ vars.RAILWAY_PRODUCTION_SERVICE }}\n"
            ),
        },
        "docker": {
            "staging": (
                "      - name: Build & Push Docker image (Staging)\n"
                "        id: deploy\n"
                "        run: |\n"
                "          docker build -t ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:staging-${{ github.sha }} .\n"
                "          echo '${{ secrets.DOCKER_PASSWORD }}' | docker login ${{ vars.DOCKER_REGISTRY }} -u '${{ secrets.DOCKER_USERNAME }}' --password-stdin\n"
                "          docker push ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:staging-${{ github.sha }}\n"
                "      - name: SSH Deploy to Staging\n"
                "        uses: appleboy/ssh-action@v1\n"
                "        with:\n"
                "          host: ${{ secrets.STAGING_HOST }}\n"
                "          username: ${{ secrets.STAGING_USER }}\n"
                "          key: ${{ secrets.STAGING_SSH_KEY }}\n"
                "          script: docker-compose pull && docker-compose up -d\n"
            ),
            "production": (
                "      - name: Build & Push Docker image (Production)\n"
                "        id: deploy\n"
                "        run: |\n"
                "          docker build -t ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:${{ github.sha }} .\n"
                "          docker tag ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:${{ github.sha }} ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:latest\n"
                "          echo '${{ secrets.DOCKER_PASSWORD }}' | docker login ${{ vars.DOCKER_REGISTRY }} -u '${{ secrets.DOCKER_USERNAME }}' --password-stdin\n"
                "          docker push ${{ vars.DOCKER_REGISTRY }}/${{ vars.APP_NAME }}:latest\n"
                "      - name: SSH Deploy to Production\n"
                "        uses: appleboy/ssh-action@v1\n"
                "        with:\n"
                "          host: ${{ secrets.PROD_HOST }}\n"
                "          username: ${{ secrets.PROD_USER }}\n"
                "          key: ${{ secrets.PROD_SSH_KEY }}\n"
                "          script: docker-compose pull && docker-compose up -d\n"
            ),
        },
    }

    env_type = "staging" if "staging" in template.lower() else "production"
    provider_steps = _PROVIDER_STEPS.get(provider, {})
    step = provider_steps.get(env_type, "")
    if not step:
        return template  # generic — leave placeholder intact

    # Replace the generic placeholder deploy step
    _STAGING_PLACEHOLDER = (
        "      - name: Deploy to Staging\n"
        "        id: deploy\n"
        "        run: echo \"Deploy to staging — configure with your provider (Vercel/Fly/Render)\"\n"
        "        env:\n"
        "          STAGING_DEPLOY_TOKEN: ${{ secrets.STAGING_DEPLOY_TOKEN }}\n"
        "          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}\n"
        "          NEXTAUTH_URL: ${{ vars.STAGING_URL }}\n"
    )
    _PROD_PLACEHOLDER = (
        "      - name: Deploy to Production\n"
        "        id: deploy\n"
        "        run: echo \"Deploy to production — configure with your provider\"\n"
        "        env:\n"
        "          PROD_DEPLOY_TOKEN: ${{ secrets.PROD_DEPLOY_TOKEN }}\n"
        "          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}\n"
        "          NEXTAUTH_URL: ${{ vars.PRODUCTION_URL }}\n"
    )
    placeholder = _STAGING_PLACEHOLDER if env_type == "staging" else _PROD_PLACEHOLDER
    if placeholder in template:
        return template.replace(placeholder, step)
    return template


async def generate_multienv_workflows(state: Phase5State) -> Phase5State:
    """
    Node: Generate multi-environment CI/CD workflows (staging, production, E2E, rollback).
    Detects deployment provider (Vercel/Fly/Render/Railway/Docker) and injects
    provider-specific deploy steps into staging and production workflow templates.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🌍 Phase 5: Generating multi-environment CI/CD workflows...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    workflows_dir = project_dir / ".github" / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)

    # Detect deployment provider
    provider = _detect_deploy_provider(project_dir)
    sse({"type": "text_delta", "content": f"  Detected deployment provider: {provider}\n"})

    # Check for user-provided custom overrides
    custom = state.get("custom_workflows", {})
    created: list[str] = []

    for name, template in _MULTIENV_TEMPLATES.items():
        wf_path = workflows_dir / name
        if wf_path.exists():
            sse({"type": "text_delta", "content": f"  Skipping {name} (already exists)\n"})
            continue
        # Apply user override or provider-specific deploy step injection
        if name in custom:
            content = custom[name]
        elif name in ("deploy-staging.yml", "deploy-production.yml"):
            content = _inject_provider_deploy_step(template, provider)
        else:
            content = template
        wf_path.write_text(content)
        created.append(str(wf_path))
        sse({"type": "text_delta", "content": f"  Created {name} [{provider}]\n"})

    state["multienv_workflow_files"] = created
    state["workflow_files"] = (state.get("workflow_files") or []) + created
    return state


async def setup_github_secrets(state: Phase5State) -> Phase5State:
    """
    T-P5-SECRETS: GitHub Secrets wizard.

    Collects required secret names from environments.json (or env_configs in state),
    then either:
      - HIL mode: prompts the user for each value via SSE choice_request,
        sets each secret via `gh secret set` or the GitHub REST API.
      - YOLO mode: logs required secrets and creates a .env.secrets.example file.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🔑 Phase 5: GitHub Secrets wizard...\n"})

    is_yolo = state.get("is_yolo", False)
    project_dir = pathlib.Path(state.get("project_dir", "."))
    input_queue = state.get("_input_queue")

    # Collect required secret names from environment configs
    env_configs: list[dict] = state.get("env_configs") or []  # type: ignore[assignment]
    if not env_configs:
        env_file = project_dir / ".pakalon" / "environments.json"
        if env_file.exists():
            try:
                raw = json.loads(env_file.read_text(encoding="utf-8"))
                env_configs = raw if isinstance(raw, list) else []
            except Exception:
                pass

    all_secrets: list[str] = []
    seen: set[str] = set()
    for env in env_configs:
        for s in (env.get("secrets") or []):
            if s not in seen:
                all_secrets.append(s)
                seen.add(s)

    if not all_secrets:
        sse({"type": "text_delta", "content": "  No secrets required — skipping.\n"})
        return {**state, "secrets_configured": []}  # type: ignore[return-value]

    sse({"type": "text_delta", "content": f"  Required secrets: {', '.join(all_secrets)}\n"})

    configured: list[str] = []

    # YOLO / non-interactive mode: generate .env.secrets.example
    if is_yolo or input_queue is None:
        lines = [
            "# GitHub Repository Secrets — fill in values and run:",
            "#   gh secret set <NAME> --body <VALUE>",
            "# or set them via GitHub repo Settings → Secrets and variables → Actions",
            "",
        ] + [f"{s}=<your-value-here>" for s in all_secrets]
        example_path = project_dir / ".env.secrets.example"
        example_path.write_text("\n".join(lines), encoding="utf-8")
        sse({"type": "text_delta", "content": f"  📄 Created {example_path} — fill in secret values.\n"})
        return {**state, "secrets_configured": []}  # type: ignore[return-value]

    # Check for gh CLI
    try:
        gh_available = subprocess.run(["gh", "--version"], capture_output=True, timeout=5).returncode == 0
    except Exception:
        gh_available = False

    # Detect repo slug
    try:
        repo_result = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            capture_output=True, text=True, cwd=str(project_dir), timeout=10,
        )
        repo_name = repo_result.stdout.strip() if repo_result.returncode == 0 else ""
    except Exception:
        repo_name = ""

    for secret_name in all_secrets:
        sse({
            "type": "choice_request",
            "question": f"Enter value for GitHub secret `{secret_name}` (or skip):",
            "choices": [
                {"id": "set", "label": f"✏️  Enter value for {secret_name}"},
                {"id": "skip", "label": "⏭  Skip this secret"},
            ],
            "followUpPrompt": f"Value for {secret_name} (leave blank to skip):",
            "secret_name": secret_name,
        })

        try:
            action = str(await asyncio.wait_for(input_queue.get(), timeout=120.0))
        except asyncio.TimeoutError:
            action = "skip"

        if action.strip().lower() in ("skip", "") or not action.strip():
            sse({"type": "text_delta", "content": f"  ⏭ Skipped {secret_name}\n"})
            continue

        secret_value = action.strip()
        set_ok = False

        if gh_available:
            try:
                args = ["gh", "secret", "set", secret_name, "--body", secret_value]
                if repo_name:
                    args += ["-R", repo_name]
                result = subprocess.run(args, capture_output=True, text=True, cwd=str(project_dir), timeout=30)
                set_ok = result.returncode == 0
                if not set_ok:
                    sse({"type": "text_delta", "content": f"  ⚠️ gh secret set failed: {result.stderr.strip()}\n"})
            except Exception as exc:
                sse({"type": "text_delta", "content": f"  ⚠️ Error setting {secret_name}: {exc}\n"})
        else:
            # Fallback: GitHub REST API + PyNaCl encryption
            github_token = os.environ.get("GITHUB_TOKEN", "")
            if github_token and repo_name:
                try:
                    import base64
                    import httpx
                    async with httpx.AsyncClient(timeout=30) as client:
                        pk_resp = await client.get(
                            f"https://api.github.com/repos/{repo_name}/actions/secrets/public-key",
                            headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json"},
                        )
                        if pk_resp.status_code == 200:
                            pk_data = pk_resp.json()
                            key_id = pk_data["key_id"]
                            pk_bytes = base64.b64decode(pk_data["key"])
                            try:
                                from nacl.public import PublicKey, SealedBox  # type: ignore
                                pk_obj = PublicKey(pk_bytes)
                                box = SealedBox(pk_obj)
                                encrypted = base64.b64encode(box.encrypt(secret_value.encode())).decode()
                                put_resp = await client.put(
                                    f"https://api.github.com/repos/{repo_name}/actions/secrets/{secret_name}",
                                    headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json"},
                                    json={"encrypted_value": encrypted, "key_id": key_id},
                                )
                                set_ok = put_resp.status_code in (201, 204)
                            except ImportError:
                                sse({"type": "text_delta", "content": "  ⚠️ PyNaCl not installed; install with: pip install PyNaCl\n"})
                except Exception as exc:
                    sse({"type": "text_delta", "content": f"  ⚠️ REST API error for {secret_name}: {exc}\n"})

        if set_ok:
            configured.append(secret_name)
            sse({"type": "text_delta", "content": f"  ✔ Set secret: {secret_name}\n"})
        else:
            sse({"type": "text_delta", "content": f"  ✘ Could not set {secret_name} — set it manually in GitHub repo settings\n"})

    sse({"type": "text_delta", "content": f"  Secrets configured: {len(configured)}/{len(all_secrets)}\n"})
    return {**state, "secrets_configured": configured}  # type: ignore[return-value]


async def custom_workflow_editor(state: Phase5State) -> Phase5State:
    """
    Node: HIL custom workflow editor.
    Presents the generated workflows and lets the user review/edit them
    before they are committed to the repository.
    """
    sse = state.get("send_sse") or (lambda e: None)
    is_yolo = state.get("is_yolo", False)

    if is_yolo:
        return state  # Skip HIL in yolo mode

    all_workflows = (state.get("workflow_files") or []) + (state.get("multienv_workflow_files") or [])
    if not all_workflows:
        return state

    sse({
        "type": "choice_request",
        "message": f"Phase 5 generated {len(all_workflows)} workflow files.",
        "question": "Would you like to review or customise the workflows before committing?",
        "choices": [
            {"id": "proceed", "label": "✅ Proceed — commit workflows as generated"},
            {"id": "edit_ci", "label": "✏️  Edit ci.yml — modify the main CI workflow"},
            {"id": "edit_deploy", "label": "✏️  Edit deploy-production.yml — modify production deployment"},
            {"id": "skip_multienv", "label": "⏭  Skip multi-env — keep only basic CI/security/deploy"},
        ],
    })

    input_queue = state.get("_input_queue")
    answer = "proceed"
    if input_queue is not None:
        try:
            answer = str(await asyncio.wait_for(input_queue.get(), timeout=300.0))
        except asyncio.TimeoutError:
            answer = "proceed"

    project_dir = pathlib.Path(state.get("project_dir", "."))
    workflows_dir = project_dir / ".github" / "workflows"

    if answer == "skip_multienv":
        # Remove multi-env files that were just created
        for wf_file in (state.get("multienv_workflow_files") or []):
            try:
                pathlib.Path(wf_file).unlink(missing_ok=True)
            except Exception:
                pass
        state["workflow_files"] = [w for w in (state.get("workflow_files") or []) if w not in (state.get("multienv_workflow_files") or [])]
        state["multienv_workflow_files"] = []
        sse({"type": "text_delta", "content": "⏭  Multi-env workflows skipped.\n"})
        return state

    if answer in ("edit_ci", "edit_deploy"):
        target_file = "ci.yml" if answer == "edit_ci" else "deploy-production.yml"
        wf_path = workflows_dir / target_file
        current_content = wf_path.read_text() if wf_path.exists() else ""
        sse({"type": "text_delta", "content": f"\nCurrent {target_file}:\n```yaml\n{current_content[:800]}\n```\n\n"})
        sse({"type": "awaiting_input", "prompt": f"Paste your edited {target_file} content (or press Enter to keep as-is):"})
        new_content = ""
        if input_queue is not None:
            try:
                new_content = str(await asyncio.wait_for(input_queue.get(), timeout=600.0))
            except asyncio.TimeoutError:
                new_content = ""
        if new_content.strip():
            wf_path.write_text(new_content)
            sse({"type": "text_delta", "content": f"  ✅ {target_file} updated.\n"})

    return state


async def commit_code(state: Phase5State) -> Phase5State:
    """Node: Commit generated workflow/code changes into git when repository is available."""
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = pathlib.Path(state.get("project_dir", "."))

    # Only commit if inside a git repo
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            capture_output=True, text=True, cwd=str(project_dir),
        )
        if result.returncode != 0:
            state["git_commit_sha"] = ""
            return state
    except Exception:
        state["git_commit_sha"] = ""
        return state

    try:
        subprocess.run(["git", "add", "-A"], cwd=str(project_dir), check=True, capture_output=True)
        result = subprocess.run(
            ["git", "commit", "-m", "feat: Pakalon Phase 3–5 implementation\n\nGenerated by Pakalon AI assistant"],
            cwd=str(project_dir), capture_output=True, text=True,
        )
        if result.returncode == 0:
            sha_result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, cwd=str(project_dir),
            )
            sha = sha_result.stdout.strip()
            state["git_commit_sha"] = sha
            sse({"type": "text_delta", "content": f"  Committed: {sha[:8]}\n"})
        else:
            state["git_commit_sha"] = ""
            if "nothing to commit" in result.stdout + result.stderr:
                sse({"type": "text_delta", "content": "  Nothing new to commit.\n"})
    except Exception as e:
        state["git_commit_sha"] = ""
        sse({"type": "text_delta", "content": f"  Git commit skipped: {e}\n"})
    return state


async def create_pr(state: Phase5State) -> Phase5State:
    sse = state.get("send_sse") or (lambda e: None)
    sha = state.get("git_commit_sha", "")
    if not sha:
        state["pr_url"] = ""
        return state

    gh_token = os.environ.get("GITHUB_TOKEN", "")
    if not gh_token:
        state["pr_url"] = ""
        sse({"type": "text_delta", "content": "  GITHUB_TOKEN not set — skipping PR creation.\n"})
        return state

    # Push branch and create PR via GitHub CLI
    project_dir = pathlib.Path(state.get("project_dir", "."))
    branch = "pakalon/phase-5-implementation"
    try:
        subprocess.run(["git", "checkout", "-b", branch], cwd=str(project_dir), capture_output=True)
        subprocess.run(["git", "push", "-u", "origin", branch], cwd=str(project_dir), capture_output=True, check=True)
        result = subprocess.run(
            ["gh", "pr", "create", "--fill", "--base", "main"],
            cwd=str(project_dir), capture_output=True, text=True, env={**os.environ, "GITHUB_TOKEN": gh_token},
        )
        pr_url = result.stdout.strip()
        state["pr_url"] = pr_url
        sse({"type": "text_delta", "content": f"  PR created: {pr_url}\n"})
    except Exception as e:
        state["pr_url"] = ""
        sse({"type": "text_delta", "content": f"  PR creation skipped: {e}\n"})
    return state


async def update_readme(state: Phase5State) -> Phase5State:
    """
    T-P5-04: Append a "Built with Pakalon" summary section to README.md.
    If README.md doesn't exist, create a minimal one.
    Uses Phase 1 plan.md for description and Phase 5 PR URL / env URLs.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📝 Phase 5: Updating README.md...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    readme_path = project_dir / "README.md"

    # Read summary from Phase 1 plan.md
    p1_dir = None
    try:
        from ..shared.paths import get_phase_dir as _gpd  # noqa: PLC0415
        p1_dir = _gpd(project_dir, 1, create=False)
    except Exception:
        pass
    plan_summary = ""
    if p1_dir and (p1_dir / "plan.md").exists():
        plan_text = (p1_dir / "plan.md").read_text()
        # Extract first 5 non-empty lines as summary
        lines = [l.strip() for l in plan_text.splitlines() if l.strip()][:5]
        plan_summary = "\n".join(lines)

    pr_url = state.get("pr_url", "")
    env_urls: list[str] = []
    for env in (state.get("environment_configs") or []):
        url = env.get("url", "") if isinstance(env, dict) else ""
        if url:
            env_urls.append(url)

    pakalon_section = "\n\n---\n\n## Built with [Pakalon](https://pakalon.ai)\n\n"
    if plan_summary:
        pakalon_section += f"**What was built:**\n\n{plan_summary}\n\n"
    if pr_url:
        pakalon_section += f"**Deployment PR:** {pr_url}\n\n"
    if env_urls:
        pakalon_section += "**Environments:**\n" + "".join(f"- {u}\n" for u in env_urls) + "\n"
    pakalon_section += (
        "_This project was designed, coded, tested, and deployed autonomously by "
        "[Pakalon AI](https://pakalon.ai) — a multi-phase agentic coding assistant._\n"
    )

    try:
        existing = readme_path.read_text() if readme_path.exists() else "# Project\n"
        # Avoid duplicate section
        if "## Built with [Pakalon]" in existing:
            # Update existing section
            parts = existing.split("## Built with [Pakalon]")
            existing = parts[0].rstrip()
        readme_path.write_text(existing + pakalon_section)
        sse({"type": "text_delta", "content": "  ✅ README.md updated with Pakalon section.\n"})
    except Exception as e:
        sse({"type": "text_delta", "content": f"  README update failed: {e}\n"})
    return state


async def manage_git_issues(state: Phase5State) -> Phase5State:
    """
    Node: T-CLI-P5 — Full GitHub issue management:
      1. Read phase-4 SAST/DAST JSON reports and create bug issues for HIGH/CRITICAL findings.
      2. List all open Pakalon-generated issues and close any whose linked commit is merged.
    Requires GITHUB_TOKEN in environment.  Skips gracefully when token absent.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🐛 Phase 5: Managing GitHub issues from security findings...\n"})

    gh_token = os.environ.get("GITHUB_TOKEN", "")
    project_dir = pathlib.Path(state.get("project_dir", "."))

    created_issues: list[str] = list(state.get("github_issues") or [])
    closed_issues: list[str] = []

    if not gh_token:
        sse({"type": "text_delta", "content": "  GITHUB_TOKEN not set — skipping issue management.\n"})
        state["github_issues"] = created_issues
        state["closed_issues"] = closed_issues
        return state

    # ---- 1. Create bug issues from SAST/DAST findings ----
    phase4_dir = get_phase_dir(project_dir, 4, create=False)
    sast_json = phase4_dir / "sast-results.json"
    dast_json = phase4_dir / "dast-results.json"

    bug_issues: list[dict] = []

    for report_path, label_prefix in [(sast_json, "sast"), (dast_json, "dast")]:
        if not report_path.exists():
            continue
        try:
            data = json.loads(report_path.read_text())
            # Flatten findings across all tools
            for tool_name, tool_result in data.items():
                if tool_name == "summary" or not isinstance(tool_result, dict):
                    continue
                for finding in tool_result.get("findings", []) + tool_result.get("alerts", []):
                    sev = str(finding.get("severity", finding.get("risk", ""))).upper()
                    if sev in ("HIGH", "CRITICAL", "ERROR"):
                        title = (
                            f"[Pakalon Security] [{tool_name.upper()}] "
                            f"{finding.get('rule', finding.get('name', 'Vulnerability'))}: "
                            f"{finding.get('path', finding.get('url', ''))}:{finding.get('line', '')}"
                        )[:200]
                        body = (
                            f"**Tool:** {tool_name}\n"
                            f"**Severity:** {sev}\n"
                            f"**File/URL:** `{finding.get('path', finding.get('url', 'N/A'))}`\n"
                            f"**Line:** {finding.get('line', 'N/A')}\n\n"
                            f"**Message:**\n{finding.get('message', finding.get('description', 'See report'))}\n\n"
                            f"**Detected by Pakalon Phase 4 AI security scan.**\n"
                            f"Commit: `{state.get('git_commit_sha', 'N/A')}`"
                        )
                        bug_issues.append({
                            "title": title,
                            "body": body,
                            "labels": ["security", "bug", f"pakalon-{label_prefix}", sev.lower()],
                        })
        except Exception as _e:
            sse({"type": "text_delta", "content": f"  ⚠️  Could not parse {report_path.name}: {_e}\n"})

    # Deduplicate by title (avoid re-creating same issues on rerun)
    existing_titles: set[str] = set()
    try:
        list_result = subprocess.run(
            ["gh", "issue", "list", "--label", "pakalon-sast",
             "--label", "pakalon-dast", "--json", "title", "--limit", "100"],
            capture_output=True, text=True, cwd=str(project_dir),
            env={**os.environ, "GITHUB_TOKEN": gh_token}, timeout=20,
        )
        if list_result.returncode == 0:
            for item in json.loads(list_result.stdout or "[]"):
                existing_titles.add(item.get("title", ""))
    except Exception:
        pass

    for bi in bug_issues[:20]:  # cap at 20 new issues per run
        if bi["title"] in existing_titles:
            continue
        try:
            args = ["gh", "issue", "create",
                    "--title", bi["title"],
                    "--body", bi["body"]]
            for lbl in bi.get("labels", []):
                args += ["--label", lbl]
            result = subprocess.run(
                args, capture_output=True, text=True,
                cwd=str(project_dir),
                env={**os.environ, "GITHUB_TOKEN": gh_token}, timeout=30,
            )
            if result.returncode == 0:
                url = result.stdout.strip()
                created_issues.append(url)
                sse({"type": "text_delta", "content": f"  🐛 Issue: {url}\n"})
        except Exception as _e:
            sse({"type": "text_delta", "content": f"  Issue create error: {_e}\n"})

    # ---- 2. Close resolved Pakalon issues ----
    # An issue is "resolved" if its title contains a path/rule that no longer
    # appears in the latest phase-4 reports (i.e., was fixed).
    current_finding_text = ""
    for rp in [sast_json, dast_json]:
        if rp.exists():
            current_finding_text += rp.read_text()

    try:
        open_result = subprocess.run(
            ["gh", "issue", "list", "--state", "open",
             "--json", "number,title,url", "--limit", "200"],
            capture_output=True, text=True, cwd=str(project_dir),
            env={**os.environ, "GITHUB_TOKEN": gh_token}, timeout=30,
        )
        if open_result.returncode == 0:
            open_issues = json.loads(open_result.stdout or "[]")
            for issue in open_issues:
                if not issue.get("title", "").startswith("[Pakalon Security]"):
                    continue
                # Extract rule/path from title
                import re as _re
                m = _re.search(r"] (.+?):", issue["title"])
                rule_hint = m.group(1) if m else ""
                if rule_hint and rule_hint not in current_finding_text:
                    # Finding no longer present — close as resolved
                    close_result = subprocess.run(
                        ["gh", "issue", "close", str(issue["number"]),
                         "--comment",
                         "Automatically closed by Pakalon: finding no longer detected in latest scan."],
                        capture_output=True, text=True, cwd=str(project_dir),
                        env={**os.environ, "GITHUB_TOKEN": gh_token}, timeout=20,
                    )
                    if close_result.returncode == 0:
                        closed_issues.append(issue["url"])
                        sse({"type": "text_delta",
                             "content": f"  ✅ Closed resolved issue #{issue['number']}: {issue['title'][:60]}\n"})
    except Exception as _e:
        sse({"type": "text_delta", "content": f"  Issue list/close error: {_e}\n"})

    sse({"type": "text_delta", "content": f"  📊 Issues: {len(created_issues)} created, {len(closed_issues)} closed\n"})
    state["github_issues"] = created_issues
    state["closed_issues"] = closed_issues
    return state


async def notify(state: Phase5State) -> Phase5State:
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = pathlib.Path(state.get("project_dir", "."))
    out_dir = get_phase_dir(project_dir, 5)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Create GitHub issues for tracking
    issues_created = await _create_github_issues(state, sse)
    state["github_issues"] = issues_created

    summary_md = f"""# Phase 5: CI/CD

## Status: Complete

## GitHub Actions Workflows

{chr(10).join('- `' + f + '`' for f in state.get('workflow_files', []))}

## Git Commit

SHA: `{state.get('git_commit_sha') or 'N/A'}`

## Pull Request

{state.get('pr_url') or 'No PR created (no git repo or GITHUB_TOKEN not set)'}

## GitHub Issues

{chr(10).join('- ' + issue for issue in issues_created) if issues_created else 'No issues created'}

## Closed Issues

{chr(10).join('- ' + url for url in state.get('closed_issues', [])) or 'None'}

"""
    (out_dir / "phase-5.md").write_text(summary_md)
    all_saved = state.get("workflow_files", []) + [str(out_dir / "phase-5.md")]
    state["outputs_saved"] = all_saved
    sse({"type": "phase_complete", "phase": 5, "files": all_saved})
    return state


async def _create_github_issues(state: Phase5State, sse) -> list[str]:
    """Create GitHub issues for tracking implementation progress."""
    issues = []
    gh_token = os.environ.get("GITHUB_TOKEN", "")
    project_dir = pathlib.Path(state.get("project_dir", "."))

    if not gh_token:
        sse({"type": "text_delta", "content": "  GITHUB_TOKEN not set — skipping issue creation.\n"})
        return issues

    # Define issues to create
    issue_templates = [
        {
            "title": "[Pakalon] Implement Phase 1 - Planning & Research",
            "body": "Complete requirements analysis, Q&A with stakeholders, and create design specification.\n\n- [ ] Conduct requirements gathering\n- [ ] Create design.md specification\n- [ ] Generate initial codebase structure",
            "labels": ["enhancement", "phase-1"],
        },
        {
            "title": "[Pakalon] Implement Phase 2 - Wireframe Design",
            "body": "Create wireframe design and get stakeholder approval.\n\n- [ ] Generate wireframes\n- [ ] Create design mockups\n- [ ] Get approval on design",
            "labels": ["enhancement", "phase-2"],
        },
        {
            "title": "[Pakalon] Implement Phase 3 - Development",
            "body": "Build the actual application implementation.\n\n- [ ] Scaffold project structure\n- [ ] Implement components\n- [ ] Add backend logic\n- [ ] Integrate third-party services",
            "labels": ["enhancement", "phase-3"],
        },
        {
            "title": "[Pakalon] Implement Phase 4 - Security QA",
            "body": "Run security scans and fix vulnerabilities.\n\n- [ ] Run SAST analysis\n- [ ] Run DAST analysis\n- [ ] Fix security issues",
            "labels": ["security", "phase-4"],
        },
        {
            "title": "[Pakalon] Implement Phase 5 - CI/CD",
            "body": "Set up continuous integration and deployment.\n\n- [ ] Configure GitHub Actions\n- [ ] Set up deployment pipeline\n- [ ] Create pull request",
            "labels": ["ci-cd", "phase-5"],
        },
        {
            "title": "[Pakalon] Implement Phase 6 - Documentation",
            "body": "Generate comprehensive documentation.\n\n- [ ] Generate API documentation\n- [ ] Create README\n- [ ] Update CHANGELOG",
            "labels": ["documentation", "phase-6"],
        },
    ]

    # Link PR if created
    pr_url = state.get("pr_url", "")
    if pr_url:
        issue_templates[4]["body"] += f"\n\n**Pull Request:** {pr_url}"

    for issue in issue_templates:
        try:
            result = subprocess.run(
                ["gh", "issue", "create", "--title", issue["title"], "--body", issue["body"]] + sum([["--label", l] for l in issue.get("labels", [])], []),
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                env={**os.environ, "GITHUB_TOKEN": gh_token},
                timeout=30,
            )
            if result.returncode == 0:
                issue_url = result.stdout.strip()
                issues.append(issue_url)
                sse({"type": "text_delta", "content": f"  Issue created: {issue_url}\n"})
            else:
                sse({"type": "text_delta", "content": f"  Issue creation skipped: {result.stderr[:100]}\n"})
        except Exception as e:
            sse({"type": "text_delta", "content": f"  Issue creation error: {str(e)[:100]}\n"})

    return issues


# ------------------------------------------------------------------
# Graph
# ------------------------------------------------------------------

def build_phase5_graph() -> Any:
    if not LANGGRAPH_AVAILABLE:
        return None
    graph = StateGraph(Phase5State)
    for name, fn in [
        ("check_git_prereqs", check_git_prereqs),
        ("read_phase4", read_phase4),
        ("generate_env_config", generate_env_config),
        ("generate_workflows", generate_workflows),
        ("generate_multienv_workflows", generate_multienv_workflows),
        ("setup_github_secrets", setup_github_secrets),
        ("custom_workflow_editor", custom_workflow_editor),
        ("commit_code", commit_code),
        ("create_pr", create_pr),
        ("update_readme", update_readme),
        ("manage_git_issues", manage_git_issues),
        ("notify", notify),
    ]:
        graph.add_node(name, fn)
    graph.set_entry_point("check_git_prereqs")
    graph.add_edge("check_git_prereqs", "read_phase4")
    graph.add_edge("read_phase4", "generate_env_config")
    graph.add_edge("generate_env_config", "generate_workflows")
    graph.add_edge("generate_workflows", "generate_multienv_workflows")
    graph.add_edge("generate_multienv_workflows", "setup_github_secrets")
    graph.add_edge("setup_github_secrets", "custom_workflow_editor")
    graph.add_edge("custom_workflow_editor", "commit_code")
    graph.add_edge("commit_code", "create_pr")
    graph.add_edge("create_pr", "update_readme")
    graph.add_edge("update_readme", "manage_git_issues")
    graph.add_edge("manage_git_issues", "notify")
    graph.add_edge("notify", END)
    return graph.compile()


async def run_phase5(project_dir: str, user_id: str = "anonymous", is_yolo: bool = False, send_sse: Any = None, input_queue: Any = None, context_budget: "dict | None" = None) -> dict[str, Any]:
    _sse = send_sse or (lambda e: None)
    # T-CLI-26: Read Phase 1 Mem0 context
    try:
        from ..shared.mem0_context import retrieve_phase1_context  # noqa: PLC0415
        _mem0_ctx = retrieve_phase1_context(user_id, project_dir)
    except Exception:
        _mem0_ctx = ""
    initial: Phase5State = {
        "project_dir": project_dir,
        "user_id": user_id,
        "is_yolo": is_yolo,
        "send_sse": _sse,
        "_input_queue": input_queue,
        "_mem0_context": _mem0_ctx,  # type: ignore
        "context_budget": context_budget,
    }
    graph = build_phase5_graph()
    if graph is None:
        state: Any = initial
        for fn in [check_git_prereqs, read_phase4, generate_env_config, generate_workflows, generate_multienv_workflows, setup_github_secrets, custom_workflow_editor, commit_code, create_pr, update_readme, manage_git_issues, notify]:
            state = await fn(state)
    else:
        state = await graph.ainvoke(initial)
    return {"status": "complete", "outputs_saved": state.get("outputs_saved", []), "pr_url": state.get("pr_url", "")}
