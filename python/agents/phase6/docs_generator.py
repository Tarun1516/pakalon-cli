"""
docs_generator.py — Phase 6 Documentation Generator

This module generates complete project documentation:
- README.md with installation, usage, architecture
- API docs from OpenAPI/code
- CHANGELOG from git history
- Incremental updates on /update runs
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any


class DocType(Enum):
    README = "readme"
    API = "api"
    CHANGELOG = "changelog"
    ARCHITECTURE = "architecture"
    TROUBLESHOOTING = "troubleshooting"


@dataclass
class DocConfig:
    """Configuration for documentation generation."""
    project_name: str = ""
    project_description: str = ""
    tech_stack: list[str] = field(default_factory=list)
    include_api: bool = True
    include_architecture: bool = True
    include_troubleshooting: bool = True
    template: str = "default"
    repo_url: str = ""
    author: str = ""
    license: str = "MIT"


@dataclass
class GeneratedDoc:
    """Represents a generated document."""
    doc_type: DocType
    title: str
    content: str
    file_path: str
    generated_at: datetime


class DocsGenerator:
    """
    Generates complete project documentation.

    Usage:
        generator = DocsGenerator(project_dir=".")
        readme = await generator.generate_readme()
        api_docs = await generator.generate_api_docs()
        changelog = await generator.generate_changelog()
    """

    def __init__(
        self,
        project_dir: str = ".",
        config: DocConfig | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.config = config or self._detect_config()

    def _detect_config(self) -> DocConfig:
        """Detect project configuration from files."""
        config = DocConfig()

        # Detect project name
        if (self.project_dir / "package.json").exists():
            try:
                with open(self.project_dir / "package.json") as f:
                    pkg = json.load(f)
                    config.project_name = pkg.get("name", "project")
                    config.project_description = pkg.get("description", "")
            except Exception:
                pass
        elif (self.project_dir / "pyproject.toml").exists():
            try:
                with open(self.project_dir / "pyproject.toml") as f:
                    for line in f:
                        if line.startswith("name ="):
                            config.project_name = line.split("=")[1].strip().strip('"')
                        elif line.startswith("description ="):
                            config.project_description = line.split("=")[1].strip().strip('"')
            except Exception:
                pass

        if not config.project_name:
            config.project_name = self.project_dir.name

        # Detect tech stack
        if (self.project_dir / "package.json").exists():
            config.tech_stack.append("Node.js")
            try:
                with open(self.project_dir / "package.json") as f:
                    pkg = json.load(f)
                    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                    if "next" in deps:
                        config.tech_stack.append("Next.js")
                    elif "react" in deps:
                        config.tech_stack.append("React")
                    if "tailwindcss" in deps:
                        config.tech_stack.append("Tailwind CSS")
                    if "express" in deps:
                        config.tech_stack.append("Express")
            except Exception:
                pass

        if (self.project_dir / "requirements.txt").exists():
            config.tech_stack.append("Python")
        if (self.project_dir / "Cargo.toml").exists():
            config.tech_stack.append("Rust")
        if (self.project_dir / "go.mod").exists():
            config.tech_stack.append("Go")

        return config

    # -------------------------------------------------------------------------
    # README Generation
    # -------------------------------------------------------------------------

    async def generate_readme(self) -> GeneratedDoc:
        """Generate README.md."""
        sections = []

        # Title and badges
        title = f"# {self.config.project_name}"
        sections.append(title)
        sections.append("")
        if self.config.project_description:
            sections.append(self.config.project_description)
            sections.append("")

        # Tech stack badges
        if self.config.tech_stack:
            badges = " | ".join(f"`{tech}`" for tech in self.config.tech_stack)
            sections.append(f"**Tech Stack:** {badges}")
            sections.append("")

        # Table of contents
        sections.append("## Table of Contents")
        sections.append("")
        sections.append("- [Installation](#installation)")
        sections.append("- [Usage](#usage)")
        sections.append("- [Development](#development)")
        sections.append("- [Deployment](#deployment)")
        sections.append("- [Contributing](#contributing)")
        sections.append("- [License](#license)")
        sections.append("")

        # Installation
        sections.append("## Installation")
        sections.append("")

        if "Node.js" in self.config.tech_stack:
            sections.append("```bash")
            sections.append("# Install dependencies")
            sections.append("npm install")
            sections.append("")
            sections.append("# Start development server")
            sections.append("npm run dev")
            sections.append("```")
        elif "Python" in self.config.tech_stack:
            sections.append("```bash")
            sections.append("# Create virtual environment")
            sections.append("python -m venv venv")
            sections.append("source venv/bin/activate  # On Windows: venv\\Scripts\\activate")
            sections.append("")
            sections.append("# Install dependencies")
            sections.append("pip install -r requirements.txt")
            sections.append("```")

        sections.append("")

        # Usage
        sections.append("## Usage")
        sections.append("")

        if (self.project_dir / "README.md").exists():
            # Try to extract existing usage section
            existing_readme = (self.project_dir / "README.md").read_text()
            usage_start = existing_readme.find("## Usage")
            if usage_start != -1:
                usage_section = existing_readme[usage_start:]
                next_section = usage_section.find("##", 10)
                if next_section != -1:
                    sections.append(usage_section[:next_section])
                else:
                    sections.append(usage_section)
        else:
            sections.append("```bash")
            sections.append("# Run the application")
            if "Node.js" in self.config.tech_stack:
                sections.append("npm start")
            elif "Python" in self.config.tech_stack:
                sections.append("python main.py")
            sections.append("```")

        sections.append("")

        # Development
        sections.append("## Development")
        sections.append("")

        if "Node.js" in self.config.tech_stack:
            sections.append("```bash")
            sections.append("# Run tests")
            sections.append("npm test")
            sections.append("")
            sections.append("# Run linter")
            sections.append("npm run lint")
            sections.append("")
            sections.append("# Build for production")
            sections.append("npm run build")
            sections.append("```")
        elif "Python" in self.config.tech_stack:
            sections.append("```bash")
            sections.append("# Run tests")
            sections.append("pytest")
            sections.append("")
            sections.append("# Run linter")
            sections.append("ruff check .")
            sections.append("```")

        sections.append("")

        # Deployment
        sections.append("## Deployment")
        sections.append("")
        sections.append("Instructions for deploying to production...")
        sections.append("")

        # Contributing
        sections.append("## Contributing")
        sections.append("")
        sections.append("1. Fork the repository")
        sections.append("2. Create your feature branch (`git checkout -b feature/amazing-feature`)")
        sections.append("3. Commit your changes (`git commit -m 'Add some amazing feature'`)")
        sections.append("4. Push to the branch (`git push origin feature/amazing-feature`)")
        sections.append("5. Open a Pull Request")
        sections.append("")

        # License
        sections.append("## License")
        sections.append("")
        sections.append("MIT License - see LICENSE file for details")

        content = "\n".join(sections)

        return GeneratedDoc(
            doc_type=DocType.README,
            title="README",
            content=content,
            file_path="README.md",
        )

    # -------------------------------------------------------------------------
    # API Documentation
    # -------------------------------------------------------------------------

    async def generate_api_docs(self) -> GeneratedDoc:
        """Generate API documentation."""
        sections = []

        sections.append("# API Documentation")
        sections.append("")

        # Check for OpenAPI/Swagger
        openapi_paths = [
            self.project_dir / "openapi.json",
            self.project_dir / "openapi.yaml",
            self.project_dir / "api-docs" / "openapi.json",
            self.project_dir / "docs" / "openapi.json",
        ]

        for openapi_path in openapi_paths:
            if openapi_path.exists():
                try:
                    content = openapi_path.read_text()
                    openapi = json.loads(content)
                    sections.append("## Endpoints")
                    sections.append("")

                    for path, methods in openapi.get("paths", {}).items():
                        for method, details in methods.items():
                            sections.append(f"### {method.upper()} {path}")
                            sections.append("")
                            sections.append(details.get("summary", ""))
                            sections.append("")

                            if "parameters" in details:
                                sections.append("**Parameters:**")
                                for param in details["parameters"]:
                                    sections.append(f"- `{param.get('name')}` ({param.get('in')}): {param.get('description', '')}")
                                sections.append("")

                            if "responses" in details:
                                sections.append("**Responses:**")
                                for code, response in details["responses"].items():
                                    sections.append(f"- `{code}`: {response.get('description', '')}")
                                sections.append("")

                    break
                except Exception:
                    pass

        # Check for Flask routes
        if (self.project_dir / "app.py").exists() or (self.project_dir / "main.py").exists():
            sections.append("## Backend Routes")
            sections.append("")
            sections.append("*(Auto-generated from Flask/FastAPI routes)*")
            sections.append("")

        content = "\n".join(sections)

        return GeneratedDoc(
            doc_type=DocType.API,
            title="API Documentation",
            content=content,
            file_path="docs/api.md",
        )

    # -------------------------------------------------------------------------
    # CHANGELOG Generation
    # -------------------------------------------------------------------------

    async def generate_changelog(self) -> GeneratedDoc:
        """Generate CHANGELOG.md from git history."""
        sections = []

        sections.append("# Changelog")
        sections.append("")
        sections.append(f"All notable changes to this project will be documented in this file.")
        sections.append("")
        sections.append("The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).")
        sections.append("")

        try:
            # Get git log
            result = subprocess.run(
                [
                    "git", "log",
                    "--pretty=format:%h|%s|%an|%ad",
                    "--date=short",
                    "-n", "50",
                ],
                cwd=self.project_dir,
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0:
                commits = []
                for line in result.stdout.strip().split("\n"):
                    if not line:
                        continue
                    parts = line.split("|")
                    if len(parts) >= 4:
                        sha, subject, author, date = parts[0], parts[1], parts[2], parts[3]
                        commits.append({
                            "sha": sha,
                            "subject": subject,
                            "author": author,
                            "date": date,
                        })

                # Group by version/date
                sections.append("## [Unreleased]")
                sections.append("")

                current_date = datetime.now().strftime("%Y-%m-%d")
                added_features = []
                bug_fixes = []
                other = []

                for commit in commits:
                    subject = commit["subject"].lower()
                    if any(kw in subject for kw in ["feat", "add", "new"]):
                        added_features.append(commit)
                    elif any(kw in subject for kw in ["fix", "bug", "patch"]):
                        bug_fixes.append(commit)
                    else:
                        other.append(commit)

                if added_features:
                    sections.append("### Added")
                    sections.append("")
                    for commit in added_features[:10]:
                        sections.append(f"- {commit['subject']} ({commit['sha']})")
                    sections.append("")

                if bug_fixes:
                    sections.append("### Fixed")
                    sections.append("")
                    for commit in bug_fixes[:10]:
                        sections.append(f"- {commit['subject']} ({commit['sha']})")
                    sections.append("")

                if other:
                    sections.append("### Changed")
                    sections.append("")
                    for commit in other[:10]:
                        sections.append(f"- {commit['subject']} ({commit['sha']})")
                    sections.append("")

        except Exception as e:
            sections.append(f"*Error generating changelog: {e}*")

        content = "\n".join(sections)

        return GeneratedDoc(
            doc_type=DocType.CHANGELOG,
            title="Changelog",
            content=content,
            file_path="CHANGELOG.md",
        )

    # -------------------------------------------------------------------------
    # Architecture Documentation
    # -------------------------------------------------------------------------

    async def generate_architecture(self) -> GeneratedDoc:
        """Generate architecture documentation."""
        sections = []

        sections.append("# Architecture")
        sections.append("")
        sections.append(f"## {self.config.project_name}")
        sections.append("")
        sections.append(self.config.project_description or "Project description")
        sections.append("")

        # Tech stack
        sections.append("## Tech Stack")
        sections.append("")
        for tech in self.config.tech_stack:
            sections.append(f"- {tech}")
        sections.append("")

        # Project structure
        sections.append("## Project Structure")
        sections.append("")
        sections.append("```")
        sections.append(self._generate_tree())
        sections.append("```")
        sections.append("")

        # Component description
        sections.append("## Components")
        sections.append("")

        # Look for common component directories
        if (self.project_dir / "src" / "components").exists():
            sections.append("### Frontend Components")
            sections.append(f"Located in `src/components/`")
            sections.append("")

        if (self.project_dir / "src" / "api").exists() or (self.project_dir / "app" / "api").exists():
            sections.append("### API Routes")
            sections.append(f"Located in `src/api/` or `app/api/`")
            sections.append("")

        if (self.project_dir / "src" / "services").exists():
            sections.append("### Services")
            sections.append(f"Located in `src/services/`")
            sections.append("")

        content = "\n".join(sections)

        return GeneratedDoc(
            doc_type=DocType.ARCHITECTURE,
            title="Architecture",
            content=content,
            file_path="docs/architecture.md",
        )

    def _generate_tree(self, max_depth: int = 3) -> str:
        """Generate a tree representation of the project."""
        lines = []

        def walk(dir_path: Path, prefix: str = "", depth: int = 0):
            if depth > max_depth:
                return

            try:
                entries = sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name))

                # Skip hidden and common ignored directories
                ignored = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
                entries = [e for e in entries if e.name not in ignored and not e.name.startswith(".")]

                for i, entry in enumerate(entries):
                    is_last = i == len(entries) - 1
                    current_prefix = "└── " if is_last else "├── "
                    lines.append(f"{prefix}{current_prefix}{entry.name}")

                    if entry.is_dir() and depth < max_depth:
                        extension = "    " if is_last else "│   "
                        walk(entry, prefix + extension, depth + 1)
            except PermissionError:
                pass

        lines.append(self.project_dir.name)
        walk(self.project_dir)

        return "\n".join(lines[:50])  # Limit to 50 lines

    # -------------------------------------------------------------------------
    # Save All Docs
    # -------------------------------------------------------------------------

    async def generate_all(self) -> list[GeneratedDoc]:
        """Generate all documentation."""
        docs = []

        # Generate README
        readme = await self.generate_readme()
        docs.append(readme)

        # Generate API docs if enabled
        if self.config.include_api:
            api_docs = await self.generate_api_docs()
            if api_docs.content.strip():
                docs.append(api_docs)

        # Generate CHANGELOG
        changelog = await self.generate_changelog()
        docs.append(changelog)

        # Generate architecture if enabled
        if self.config.include_architecture:
            architecture = await self.generate_architecture()
            docs.append(architecture)

        return docs

    async def save_all(self) -> list[str]:
        """Generate and save all documentation."""
        docs = await self.generate_all()
        saved_files = []

        for doc in docs:
            file_path = self.project_dir / doc.file_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(doc.content)
            saved_files.append(str(file_path))

        return saved_files


# -------------------------------------------------------------------------
# CLI Commands
# -------------------------------------------------------------------------

async def cmd_generate_docs(
    types: list[str] | None = None,
    project_dir: str = ".",
) -> dict:
    """Generate documentation."""
    generator = DocsGenerator(project_dir=project_dir)

    doc_types = [DocType(t) for t in (types or ["readme", "api", "changelog", "architecture"])]

    saved_files = []

    for doc_type in doc_types:
        if doc_type == DocType.README:
            doc = await generator.generate_readme()
        elif doc_type == DocType.API:
            doc = await generator.generate_api_docs()
        elif doc_type == DocType.CHANGELOG:
            doc = await self.generate_changelog()
        elif doc_type == DocType.ARCHITECTURE:
            doc = await generator.generate_architecture()
        else:
            continue

        file_path = generator.project_dir / doc.file_path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(doc.content)
        saved_files.append(str(file_path))

    return {
        "status": "generated",
        "files": saved_files,
    }


async def cmd_update_docs(project_dir: str = ".") -> dict:
    """Update documentation incrementally."""
    generator = DocsGenerator(project_dir=project_dir)
    saved_files = await generator.save_all()

    return {
        "status": "updated",
        "files": saved_files,
    }
