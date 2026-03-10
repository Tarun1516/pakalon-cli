# Vercel Deploy Claimable

Deploy applications to Vercel via the Vercel API with support for claimable preview URLs, project creation, and production promotion.

## What is a "Claimable" Deployment?

A **claimable deployment** is a Vercel deployment that can be transferred to a user's own Vercel account from an agent-owned account. This pattern lets Pakalon agents deploy apps on the user's behalf without requiring credentials upfront — the user simply "claims" the deployment after review.

Flow:
1. Agent deploys to the Pakalon Vercel account → gets preview URL.
2. Agent includes a **claim link** in the output that the user clicks.
3. User authenticates with Vercel → deployment forks to their account.

## Vercel REST API

### Deploy via CLI (preferred for agents)

```bash
npx vercel deploy --token $VERCEL_TOKEN --yes --output-dir dist/
```

### Deploy via API

```python
import httpx, os

VERCEL_TOKEN = os.environ["VERCEL_TOKEN"]

def create_deployment(project_name: str, files: dict[str, str]) -> dict:
    """
    files: {"index.html": "<html>...</html>", "style.css": "..."}
    Returns deployment info including url, id, claimUrl.
    """
    # Step 1: create files
    file_refs = []
    for file_path, content in files.items():
        resp = httpx.post(
            "https://api.vercel.com/v2/files",
            headers={"Authorization": f"Bearer {VERCEL_TOKEN}",
                     "Content-Type": "application/octet-stream",
                     "x-vercel-digest": _sha1(content)},
            content=content.encode(),
        )
        file_refs.append({"file": file_path, "sha": _sha1(content), "size": len(content.encode())})

    # Step 2: create deployment
    resp = httpx.post(
        "https://api.vercel.com/v13/deployments",
        headers={"Authorization": f"Bearer {VERCEL_TOKEN}"},
        json={
            "name": project_name,
            "files": file_refs,
            "projectSettings": {"framework": None},
            "target": "preview",
        },
    )
    data = resp.json()
    return {
        "id": data.get("id"),
        "url": f"https://{data.get('url')}",
        "readyState": data.get("readyState"),
        "claimUrl": f"https://vercel.com/claim/{data.get('id')}",
    }

def _sha1(content: str) -> str:
    import hashlib
    return hashlib.sha1(content.encode()).hexdigest()
```

## Next.js Project Deployment

```python
def deploy_nextjs(project_dir: str, project_name: str) -> dict:
    """Build and deploy a Next.js project."""
    import subprocess, pathlib

    root = pathlib.Path(project_dir)

    # Run next build
    result = subprocess.run(
        ["npm", "run", "build"], cwd=str(root), capture_output=True, text=True
    )
    if result.returncode != 0:
        return {"error": result.stderr}

    # Deploy with Vercel CLI
    result = subprocess.run(
        ["npx", "vercel", "deploy", "--yes", "--token", os.environ.get("VERCEL_TOKEN", "")],
        cwd=str(root),
        capture_output=True,
        text=True,
    )
    lines = result.stdout.strip().splitlines()
    preview_url = next((l for l in lines if l.startswith("https://")), "")
    return {"url": preview_url, "stdout": result.stdout, "stderr": result.stderr}
```

## vercel.json Configuration

```json
{
  "version": 2,
  "builds": [
    { "src": "next.config.ts", "use": "@vercel/next" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" }
  ],
  "env": {
    "NODE_ENV": "production"
  },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" }
      ]
    }
  ]
}
```

## Environment Variables

```python
def set_env_vars(project_id: str, env_vars: dict[str, str], target: str = "production") -> bool:
    """Set Vercel project environment variables."""
    for key, value in env_vars.items():
        resp = httpx.post(
            f"https://api.vercel.com/v9/projects/{project_id}/env",
            headers={"Authorization": f"Bearer {VERCEL_TOKEN}"},
            json={"key": key, "value": value, "type": "plain", "target": [target]},
        )
        if resp.status_code not in (200, 201):
            return False
    return True
```

## Poll Deployment Status

```python
async def wait_for_deployment(deployment_id: str, timeout_s: int = 120) -> str:
    import asyncio
    async with httpx.AsyncClient() as client:
        for _ in range(timeout_s // 5):
            resp = await client.get(
                f"https://api.vercel.com/v13/deployments/{deployment_id}",
                headers={"Authorization": f"Bearer {VERCEL_TOKEN}"},
            )
            state = resp.json().get("readyState", "")
            if state in ("READY", "ERROR", "CANCELED"):
                return state
            await asyncio.sleep(5)
    return "TIMEOUT"
```

## Best Practices

- Store `VERCEL_TOKEN` in the environment — never hard-code it.
- Always poll for `readyState == "READY"` before returning the URL to the user.
- Use `--yes` (non-interactive) with the Vercel CLI in agent contexts.
- Include `vercel.json` security headers (`X-Content-Type-Options`, `X-Frame-Options`) in all deployments.
- For Next.js apps, ensure `next.config.ts` has `output: "standalone"` for Docker-compatible builds.
- The claim URL pattern is `https://vercel.com/claim/{deployment_id}` — always surface this to users.
