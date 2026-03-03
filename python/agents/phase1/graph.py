"""
graph.py — Phase 1 LangGraph StateGraph: Planning Agent.
T104: Research → codebase check → Q&A loop → Figma import → file generation.
Generates 12 files in order; streams SSE events; supports HIL and YOLO modes.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import pathlib
from typing import Any, AsyncIterator, TypedDict

import httpx

try:
    from langgraph.graph import StateGraph, END  # type: ignore
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

from ..memory.mem0_client import Mem0Client
from .skills import AgentSkillsFinder
from .figma_import import FigmaImporter
from .context_budget import ContextBudget
from ..shared.paths import get_phase_dir
from ..shared.decision_registry import record_decision

# ------------------------------------------------------------------
# Output file generation order (plan.md first, phase-1.md LAST)
# ------------------------------------------------------------------
    "constraints-and-tradeoffs.md",
    "agent-skills.md",
    "API_reference.md",
    "Database_schema.md",
    "phase-1.md",  # MUST be last
OPENROUTER_BASE = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku")

# ------------------------------------------------------------------
# State schema
# ------------------------------------------------------------------

class Phase1State(TypedDict, total=False):
    user_prompt: str
    project_dir: str
    is_new_project: bool
    is_yolo: bool
    user_id: str
    figma_url: str | None
    research_context: str
    existing_codebase_summary: str
    qa_answers: dict[str, str]
    figma_data: dict[str, Any] | None
    figma_changed_elements: list[str]  # diff vs previous figma.json snapshot
    context_budget: dict[str, int]
    generated_files: dict[str, str]
    skills_md: str
    send_sse: Any  # callable(event_dict) -> None
    _input_queue: Any  # asyncio.Queue for HIL input
    _total_context: int  # total context window tokens
    _mem0_context: str  # cross-phase Mem0 context string
    context_ratio_choice: str  # T-P1-07: 'proceed'|'ask_more'|'reduce_existing'|'end_phase1'


# ------------------------------------------------------------------
# Helper: LLM call
# ------------------------------------------------------------------

async def _llm_call(messages: list[dict], model: str = DEFAULT_MODEL, max_tokens: int = 4096) -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return "[No OPENROUTER_API_KEY]"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OPENROUTER_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "messages": messages, "max_tokens": max_tokens},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[LLM error: {e}]"


# ------------------------------------------------------------------
# Node implementations
# ------------------------------------------------------------------

async def research_web(state: Phase1State) -> Phase1State:
    """Node: Firecrawl similar products + Context7 library docs + store in Mem0."""
    sse = state.get("send_sse")
    if sse:
        sse({"type": "text_delta", "content": "🔍 Researching similar products...\n"})

    prompt_text = state.get("user_prompt", "")

    # Try Firecrawl research
    research = ""
    try:
        from ...tools.firecrawl import FirecrawlTool
        fc = FirecrawlTool()
        search_query = f"similar products to: {prompt_text[:200]}"
        # Use a search-engine-style scrape
        research = fc.scrape(f"https://www.google.com/search?q={search_query.replace(' ', '+')}")[:2000]
    except Exception as e:
        research = f"[Research unavailable: {e}]"

    # T-P1-10 / T-MCP-12: Context7 MCP — fetch up-to-date docs for detected libraries
    context7_docs = ""
    try:
        # Detect commonly used libraries from user prompt
        _library_keywords = {
            "next.js": "nextjs", "nextjs": "nextjs", "next js": "nextjs",
            "react": "react", "vue": "vue", "angular": "angular",
            "fastapi": "fastapi", "django": "django", "flask": "flask",
            "tailwind": "tailwindcss", "shadcn": "shadcn-ui",
            "prisma": "prisma", "drizzle": "drizzle-orm",
            "supabase": "supabase", "firebase": "firebase",
            "langchain": "langchain", "langgraph": "langgraph",
        }
        _lower_prompt = prompt_text.lower()
        _detected_libs = [slug for keyword, slug in _library_keywords.items() if keyword in _lower_prompt][:3]

        if _detected_libs and sse:
            sse({"type": "text_delta", "content": f"  📚 Fetching Context7 docs for: {', '.join(_detected_libs)}...\n"})

        _BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://127.0.0.1:9001")
        _context7_parts: list[str] = []
        async with httpx.AsyncClient(timeout=30) as _client:
            for lib_slug in _detected_libs:
                try:
                    # Context7 MCP SSE transport: resolve-library-docs tool
                    _resp = await _client.post(
                        f"{_BRIDGE_URL}/mcp/context7/resolve-library-docs",
                        json={"libraryId": lib_slug, "tokens": 3000},
                    )
                    if _resp.status_code == 200:
                        _data = _resp.json()
                        _docs_text = _data.get("content") or _data.get("text") or ""
                        if _docs_text:
                            _context7_parts.append(f"## {lib_slug} (Context7)\n{_docs_text[:1500]}")
                except Exception:
                    pass  # Context7 unavailable — fall back silently

        if _context7_parts:
            context7_docs = "\n\n".join(_context7_parts)
            if sse:
                sse({"type": "text_delta", "content": f"  ✅ Context7 docs fetched for {len(_context7_parts)} librar(ies)\n"})
    except Exception:
        pass  # non-fatal

    # Combine research
    full_research = research
    if context7_docs:
        full_research = f"{research}\n\n# Library Documentation (Context7)\n{context7_docs}"

    # Store in Mem0
    try:
        mem = Mem0Client(
            state.get("user_id", "anonymous"),
            hashlib.sha256(state.get("project_dir", ".").encode()).hexdigest()[:8],
        )
        mem.add(f"Research: {full_research[:3000]}", metadata={"type": "research", "phase": "1"})
    except Exception:
        pass

    state["research_context"] = full_research
    return state


def _read_partial(path: pathlib.Path, max_lines: int = 100) -> str:
    """Read up to *max_lines* from a text file; silently return '' on error."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = [fh.readline() for _ in range(max_lines)]
        return "".join(lines).strip()
    except Exception:
        return ""


def _collect_manifest_context(project_dir: pathlib.Path) -> dict[str, str]:
    """Read package.json, pyproject.toml, and key entry points from project_dir."""
    ctx: dict[str, str] = {}

    # --- package.json ---
    pkg_path = project_dir / "package.json"
    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
            pkg_summary = {
                "name": pkg.get("name"),
                "version": pkg.get("version"),
                "description": pkg.get("description"),
                "scripts": list(pkg.get("scripts", {}).keys()),
                "dependencies": list(pkg.get("dependencies", {}).keys()),
                "devDependencies": list(pkg.get("devDependencies", {}).keys()),
            }
            ctx["package_json"] = json.dumps(pkg_summary, indent=2)
        except Exception:
            ctx["package_json"] = _read_partial(pkg_path, 40)

    # --- pyproject.toml ---
    ppt_path = project_dir / "pyproject.toml"
    if ppt_path.exists():
        ctx["pyproject_toml"] = _read_partial(ppt_path, 60)

    # --- Key entry points (first 100 lines each) ---
    entry_candidates = [
        "src/index.ts", "src/index.tsx", "src/main.ts", "src/app.ts",
        "index.ts", "index.js",
        "app.py", "main.py", "src/main.py", "server.py",
        "App.tsx", "src/App.tsx",
    ]
    entry_content: list[str] = []
    for rel in entry_candidates:
        p = project_dir / rel
        if p.exists():
            snippet = _read_partial(p, 100)
            if snippet:
                entry_content.append(f"### {rel}\n```\n{snippet}\n```")
            if len(entry_content) >= 3:
                break  # cap at 3 entry points
    if entry_content:
        ctx["entry_points"] = "\n\n".join(entry_content)

    return ctx


async def check_existing_codebase(state: Phase1State) -> Phase1State:
    """Node: Deep-scan project dir, read manifests/entry points, LLM-summarise."""
    sse = state.get("send_sse")
    if sse:
        sse({"type": "text_delta", "content": "📁 Checking existing codebase...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    if not project_dir.exists():
        state["is_new_project"] = True
        state["existing_codebase_summary"] = "New project — no existing code."
        return state

    # Count relevant source files
    source_extensions = {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs"}
    files = [
        f for ext in source_extensions
        for f in project_dir.rglob(f"*{ext}")
        if "node_modules" not in str(f) and ".git" not in str(f)
    ]

    completeness = min(len(files) * 2, 100)  # rough estimate
    is_new = len(files) < 5
    state["is_new_project"] = is_new

    # Collect manifest / entry-point context
    manifest_ctx = _collect_manifest_context(project_dir)

    # Build raw summary (always available even without LLM)
    summary_parts: list[str] = [
        f"Project: {project_dir.name}",
        f"Source files found: {len(files)}",
        f"Estimated completeness: {completeness}%",
        f"Type: {'new project' if is_new else 'existing codebase'}",
    ]
    if not is_new and files:
        sample = [str(f.relative_to(project_dir)) for f in files[:15]]
        summary_parts.append(f"Sample files: {', '.join(sample)}")

    if manifest_ctx.get("package_json"):
        summary_parts.append(f"\n## package.json\n{manifest_ctx['package_json']}")
    if manifest_ctx.get("pyproject_toml"):
        summary_parts.append(f"\n## pyproject.toml\n{manifest_ctx['pyproject_toml']}")
    if manifest_ctx.get("entry_points"):
        summary_parts.append(f"\n## Entry Points\n{manifest_ctx['entry_points']}")

    raw_summary = "\n".join(summary_parts)

    # LLM-generated 2-paragraph narrative for richer downstream context
    llm_narrative = ""
    if not is_new and os.environ.get("OPENROUTER_API_KEY"):
        user_prompt = state.get("user_prompt", "")
        llm_prompt = (
            f"You are a senior software architect. Analyse the following codebase scan "
            f"for a project the user wants to extend/modify.\n\n"
            f"User request: {user_prompt[:300]}\n\n"
            f"Codebase scan:\n{raw_summary[:3000]}\n\n"
            f"Write exactly 2 paragraphs:\n"
            f"1. What the project currently does and its tech stack.\n"
            f"2. What existing work can be reused and what gaps need to be filled "
            f"to satisfy the user request.\n"
            f"Be precise and concise."
        )
        try:
            llm_narrative = await _llm_call(
                [{"role": "user", "content": llm_prompt}],
                max_tokens=512,
            )
            if sse:
                sse({"type": "text_delta", "content": "📋 Codebase analysis complete.\n"})
        except Exception:
            pass  # non-fatal — raw_summary is still used

    if llm_narrative:
        state["existing_codebase_summary"] = raw_summary + f"\n\n## AI Analysis\n{llm_narrative}"
    else:
        state["existing_codebase_summary"] = raw_summary

    return state


async def qa_loop(state: Phase1State) -> Phase1State:
    """
    Node: Q&A loop — min 10 questions for vague prompts.
    YOLO: auto-answers all questions.
    HIL: streams choice_request SSE events.
    Questions are AI-generated and context-aware based on user's request.
    """
    sse = state.get("send_sse")
    is_yolo = state.get("is_yolo", False)
    prompt_text = state.get("user_prompt", "")

    # Detect project type from prompt for context-aware questions
    prompt_lower = prompt_text.lower()
    is_mobile = any(kw in prompt_lower for kw in ["mobile", "android", "ios", "app", "react native", "flutter", "swift", "kotlin"])
    is_frontend = any(kw in prompt_lower for kw in ["frontend", "website", "web app", "landing page", "dashboard", "ui", "web site"])
    is_backend = any(kw in prompt_lower for kw in ["backend", "api", "server", "database", "rest"])

    # Build context-aware prompt for AI-generated questions
    if is_mobile:
        project_type = "mobile application"
    elif is_frontend:
        project_type = "frontend website or web application"
    elif is_backend:
        project_type = "backend API or server"
    else:
        project_type = "web application"

    questions_prompt = f"""You are a senior software architect. A user wants to build: "{prompt_text}"

This is a {project_type}. Generate exactly 10 clarifying questions to understand requirements.

Requirements:
1. Questions must be RELEVANT to {project_type}
2. Each question must have exactly 4 single-select answer options
3. The LAST option must always be "None of the above / Skip"
4. Make questions specific to this project type - avoid generic questions

For a mobile app, ask about: iOS/Android, push notifications, offline support, app store, camera/location
For a website, ask about: framework, styling, authentication, SEO, responsive design, third-party integrations
For a backend, ask about: language, database, API style, authentication, caching, deployment

Format as JSON array:
[{{"question": "Question?", "options": ["A", "B", "C", "None of the above / Skip"], "default_answer": "A"}}]

Return ONLY valid JSON array."""

    raw_questions = await _llm_call(
        [{"role": "user", "content": questions_prompt}],
        max_tokens=2500,
    )

    questions = []
    try:
        import re
        match = re.search(r"\[.*\]", raw_questions, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            if isinstance(parsed, list) and len(parsed) > 0:
                questions = parsed
    except Exception:
        pass

    # Context-aware fallback questions (if AI fails)
    if not questions:
        if is_mobile:
            questions = [
                {"question": "Which platforms should the app support?", "options": ["iOS only", "Android only", "Both iOS and Android", "None of the above / Skip"], "default_answer": "Both iOS and Android"},
                {"question": "Do you need push notifications?", "options": ["Yes (Firebase)", "Yes (custom)", "No notifications", "None of the above / Skip"], "default_answer": "Yes (Firebase)"},
                {"question": "Should the app work offline?", "options": ["Full offline", "Partial offline", "Online only", "None of the above / Skip"], "default_answer": "Partial offline"},
                {"question": "State management?", "options": ["Redux/Zustand", "Context API", "No complex state", "None of the above / Skip"], "default_answer": "Redux/Zustand"},
                {"question": "Need device permissions?", "options": ["Camera & location", "Location only", "No permissions", "None of the above / Skip"], "default_answer": "Location only"},
                {"question": "Authentication method?", "options": ["Social login", "Email/password", "No auth", "None of the above / Skip"], "default_answer": "Social login"},
                {"question": "In-app purchases?", "options": ["Subscriptions", "One-time purchases", "No payments", "None of the above / Skip"], "default_answer": "No payments"},
                {"question": "Target iOS version?", "options": ["Latest only", "Last 2 versions", "No requirement", "None of the above / Skip"], "default_answer": "Last 2 versions"},
                {"question": "Analytics?", "options": ["Firebase Analytics", "Custom analytics", "No analytics", "None of the above / Skip"], "default_answer": "Firebase Analytics"},
                {"question": "App assets?", "options": ["Need design", "Have assets ready", "Use defaults", "None of the above / Skip"], "default_answer": "Use defaults"},
            ]
        elif is_frontend:
            questions = [
                {"question": "Which framework?", "options": ["Next.js", "React", "Vue/Nuxt", "None of the above / Skip"], "default_answer": "Next.js"},
                {"question": "Styling?", "options": ["Tailwind CSS", "Styled Components", "CSS Modules", "None of the above / Skip"], "default_answer": "Tailwind CSS"},
                {"question": "Authentication?", "options": ["OAuth", "Email/password", "No auth", "None of the above / Skip"], "default_answer": "OAuth"},
                {"question": "Target browsers?", "options": ["Modern only", "Last 2 versions", "IE11 support", "None of the above / Skip"], "default_answer": "Modern only"},
                {"question": "SEO?", "options": ["Full SEO", "Basic meta tags", "No SEO", "None of the above / Skip"], "default_answer": "Full SEO"},
                {"question": "State management?", "options": ["Redux/Zustand", "React Query", "Context only", "None of the above / Skip"], "default_answer": "React Query"},
                {"question": "Real-time?", "options": ["WebSockets", "Server-Sent Events", "No real-time", "None of the above / Skip"], "default_answer": "No real-time"},
                {"question": "Forms?", "options": ["React Hook Form", "Formik", "Native forms", "None of the above / Skip"], "default_answer": "React Hook Form"},
                {"question": "Testing?", "options": ["Full test suite", "Unit tests only", "No tests", "None of the above / Skip"], "default_answer": "Unit tests only"},
                {"question": "Deployment?", "options": ["Vercel", "Netlify", "Self-hosted", "None of the above / Skip"], "default_answer": "Vercel"},
            ]
        elif is_backend:
            questions = [
                {"question": "Language/framework?", "options": ["Node.js/Express", "Python/FastAPI", "Go", "None of the above / Skip"], "default_answer": "Node.js/Express"},
                {"question": "Database?", "options": ["PostgreSQL", "MongoDB", "MySQL", "None of the above / Skip"], "default_answer": "PostgreSQL"},
                {"question": "Authentication?", "options": ["JWT", "Sessions", "OAuth2", "None of the above / Skip"], "default_answer": "JWT"},
                {"question": "API style?", "options": ["REST", "GraphQL", "gRPC", "None of the above / Skip"], "default_answer": "REST"},
                {"question": "Caching?", "options": ["Redis", "Memcached", "No caching", "None of the above / Skip"], "default_answer": "Redis"},
                {"question": "Message queue?", "options": ["RabbitMQ", "Kafka", "None needed", "None of the above / Skip"], "default_answer": "None needed"},
                {"question": "File storage?", "options": ["S3", "Local storage", "Cloudinary", "None of the above / Skip"], "default_answer": "S3"},
                {"question": "Background jobs?", "options": ["Celery/Bull", "Cron jobs", "No background", "None of the above / Skip"], "default_answer": "Cron jobs"},
                {"question": "API docs?", "options": ["Swagger/OpenAPI", "Postman", "No docs", "None of the above / Skip"], "default_answer": "Swagger/OpenAPI"},
                {"question": "Deployment?", "options": ["Docker/K8s", "Serverless", "Traditional", "None of the above / Skip"], "default_answer": "Docker/K8s"},
            ]
        else:
            questions = [
                {"question": "Primary tech stack?", "options": ["React/Next.js", "Vue/Nuxt", "Svelte/SvelteKit", "None of the above / Skip"], "default_answer": "React/Next.js"},
                {"question": "Database?", "options": ["PostgreSQL", "MySQL", "MongoDB", "None of the above / Skip"], "default_answer": "PostgreSQL"},
                {"question": "Authentication?", "options": ["OAuth", "Email/password", "No auth", "None of the above / Skip"], "default_answer": "OAuth"},
                {"question": "Deployment?", "options": ["Vercel", "AWS", "Docker/K8s", "None of the above / Skip"], "default_answer": "Vercel"},
                {"question": "Real-time?", "options": ["WebSockets", "SSE", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "User scale?", "options": ["<1K users", "1K-10K", "10K+", "None of the above / Skip"], "default_answer": "<1K users"},
                {"question": "Payments?", "options": ["Stripe", "PayPal", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "Styling?", "options": ["Tailwind CSS", "Styled Components", "CSS Modules", "None of the above / Skip"], "default_answer": "Tailwind CSS"},
                {"question": "Analytics?", "options": ["Google Analytics", "Custom", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "Third-party APIs?", "options": ["None needed", "AI/LLM APIs", "Social APIs", "None of the above / Skip"], "default_answer": "None needed"},
            ]

    # Enforce minimum 10 answered questions regardless of prompt detail level.
    answers: dict[str, str] = {}
    answered_count = 0
    mem = None
    try:
        mem = Mem0Client(
            state.get("user_id", "anonymous"),
            hashlib.sha256(state.get("project_dir", ".").encode()).hexdigest()[:8],
        )
    except Exception:
        pass
    min_required_answers = 10

    for i, q_obj in enumerate(questions):
        question = q_obj.get("question", f"Question {i+1}")
        options = q_obj.get("options", ["Yes", "No", "Skip"])
        default = q_obj.get("default_answer", options[0] if options else "")

        if is_yolo:
            answer = default
        else:
            # HIL: send SSE choice_request and wait for input
            if sse:
                event = {
                    "type": "choice_request",
                    "question_index": i,
                    "total_questions": len(questions),
                    "question": question,
                    "choices": [{"id": str(j), "label": opt} for j, opt in enumerate(options)],
                    "can_end": answered_count >= min_required_answers,
                    "end_label": (
                        f"End phase 1 and start phase 2 "
                        f"(answered {answered_count}/{min_required_answers} minimum; "
                        f"skip remaining {len(questions) - i - 1} questions)"
                    ),
                }
                sse(event)
            # Await input via asyncio Event (set by phase manager)
            answer = await _await_user_input(state, question_index=i, default=default)

        if answer.startswith("End phase"):
            if answered_count < min_required_answers:
                if sse:
                    sse({
                        "type": "text_delta",
                        "content": (
                            f"ℹ️  Please answer at least {min_required_answers} core questions "
                            f"before ending Phase 1. Currently answered: {answered_count}.\n"
                        ),
                    })
                continue
            break

        answers[question] = answer
        answered_count += 1

        if mem:
            mem.store_qa(question, answer)

        # ---------- Sub-question branching ----------
        skip_terms = {"none", "skip", "none of the above"}
        answer_lower = answer.lower().strip()
        is_skip = any(t in answer_lower for t in skip_terms)

        if not is_skip and not is_yolo:
            follow_ups = await _generate_followup_questions(
                prompt_text, question, answer, project_type, max_followups=2
            )
            for fu_idx, fu in enumerate(follow_ups):
                fu_question = fu.get("question", "")
                fu_options = fu.get("options", ["Yes", "No", "Skip"])
                fu_default = fu.get("default_answer", fu_options[0] if fu_options else "")
                if not fu_question:
                    continue
                if sse:
                    sse({
                        "type": "choice_request",
                        "question_index": f"{i}.{fu_idx + 1}",
                        "total_questions": len(questions),
                        "question": fu_question,
                        "choices": [{"id": str(j), "label": opt} for j, opt in enumerate(fu_options)],
                        "is_followup": True,
                        "parent_question": question,
                        "parent_answer": answer,
                        "can_end": False,
                    })
                fu_answer = await _await_user_input(state, question_index=f"{i}.{fu_idx + 1}", default=fu_default)
                answers[f"{question} → {fu_question}"] = fu_answer
                if mem:
                    mem.store_qa(f"{question} → {fu_question}", fu_answer)

    state["qa_answers"] = answers

    # Record Q&A decisions in cross-phase registry
    project_dir_str = state.get("project_dir", ".")
    for question, answer in answers.items():
        record_decision(
            project_dir_str,
            phase=1,
            decision_type="requirement",
            description=f"{question}: {answer}",
            source_file="phase-1/qa-answers",
        )

    return state


async def _generate_followup_questions(
    prompt_text: str,
    parent_question: str,
    parent_answer: str,
    project_type: str,
    max_followups: int = 2,
) -> list[dict]:
    """Ask the LLM for 1-2 context-specific follow-up questions for a given Q&A pair."""
    followup_prompt = f"""A user is building a {project_type}: "{prompt_text}"

They just answered a clarifying question.
Question: "{parent_question}"
Answer: "{parent_answer}"

Generate {max_followups} brief follow-up sub-questions that drill into their choice.
Only generate sub-questions that would meaningfully affect the implementation.
If no useful sub-questions exist, return an empty array.

Format as JSON array (max {max_followups} items):
[{{"question": "Follow-up question?", "options": ["A", "B", "Skip"], "default_answer": "A"}}]

Rules:
- Options must include "Skip" as the last choice
- Maximum 4 options per question
- Only return relevant follow-ups. Prefer 1 over 2 when 1 is sufficient.
- Return ONLY valid JSON."""

    try:
        raw = await _llm_call(
            [{"role": "user", "content": followup_prompt}],
            max_tokens=800,
        )
        import re
        match = re.search(r"\[.*?\]", raw, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                return parsed[:max_followups]
    except Exception:
        pass
    return []


async def _await_user_input(
    state: Phase1State,
    question_index: int | str,
    default: str,
    timeout: float = 300.0,
) -> str:
    """Wait for user input via asyncio queue (set by phase manager). Defaults after timeout."""
    input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore
    if input_queue is None:
        return default
    try:
        answer = await asyncio.wait_for(input_queue.get(), timeout=timeout)
        return str(answer)
    except asyncio.TimeoutError:
        return default


def _diff_figma_data(old: dict, new: dict) -> list[str]:
    """
    Compare two Figma export dicts and return a list of change descriptions.
    Looks at: component names, frame names, color tokens, typography tokens.
    """
    changes: list[str] = []

    def _names_set(data: dict, key: str) -> set[str]:
        items = data.get(key, [])
        if isinstance(items, list):
            return {str(i.get("name", i) if isinstance(i, dict) else i) for i in items}
        if isinstance(items, dict):
            return set(items.keys())
        return set()

    # Components
    old_comps = _names_set(old, "components")
    new_comps = _names_set(new, "components")
    for name in new_comps - old_comps:
        changes.append(f"component added: {name}")
    for name in old_comps - new_comps:
        changes.append(f"component removed: {name}")

    # Frames / pages
    old_frames = _names_set(old, "frames") | _names_set(old, "pages")
    new_frames = _names_set(new, "frames") | _names_set(new, "pages")
    for name in new_frames - old_frames:
        changes.append(f"frame/page added: {name}")
    for name in old_frames - new_frames:
        changes.append(f"frame/page removed: {name}")

    # Color tokens (detect palette changes by count and first-level key diff)
    old_colors = old.get("colors", {})
    new_colors = new.get("colors", {})
    if isinstance(old_colors, dict) and isinstance(new_colors, dict):
        for ck in set(new_colors) - set(old_colors):
            changes.append(f"color token added: {ck}")
        for ck in set(old_colors) - set(new_colors):
            changes.append(f"color token removed: {ck}")
        for ck in set(old_colors) & set(new_colors):
            if str(old_colors[ck]) != str(new_colors[ck]):
                changes.append(f"color token changed: {ck}")
    elif str(old_colors) != str(new_colors):
        changes.append("color palette changed")

    # Typography
    old_typo = old.get("typography", old.get("fonts", {}))
    new_typo = new.get("typography", new.get("fonts", {}))
    if str(old_typo) != str(new_typo):
        changes.append("typography/fonts changed")

    # Spacing/grid tokens
    old_spacing = old.get("spacing", old.get("grid", {}))
    new_spacing = new.get("spacing", new.get("grid", {}))
    if str(old_spacing) != str(new_spacing):
        changes.append("spacing/grid tokens changed")

    return changes


async def load_figma(state: Phase1State) -> Phase1State:
    """Node: Load Figma file, compare against cached figma.json, emit changed_elements."""
    figma_url = state.get("figma_url")
    if not figma_url:
        state["figma_data"] = None
        return state

    sse = state.get("send_sse")
    if sse:
        sse({"type": "text_delta", "content": "🎨 Importing Figma design...\n"})

    importer = FigmaImporter()
    result = importer.analyze(figma_url)
    state["figma_data"] = result

    if not result or result.get("error"):
        return state

    # Persist figma.json and compare with previous snapshot for minor-change detection
    project_dir = pathlib.Path(state.get("project_dir", "."))
    phase1_dir = get_phase_dir(project_dir, 1, create=False)
    figma_cache = phase1_dir / "figma.json"

    changed_elements: list[str] = []
    is_first_import = True

    if figma_cache.exists():
        try:
            old_data = json.loads(figma_cache.read_text())
            changed_elements = _diff_figma_data(old_data, result)
            is_first_import = False
        except Exception:
            pass

    # Write new snapshot
    try:
        phase1_dir.mkdir(parents=True, exist_ok=True)
        figma_cache.write_text(json.dumps(result, indent=2))
    except Exception:
        pass

    state["figma_changed_elements"] = changed_elements

    if is_first_import:
        if sse:
            sse({"type": "text_delta", "content": "  ✅ Figma design imported (first import — baseline saved).\n"})
    elif changed_elements:
        change_lines = "\n".join(f"    • {c}" for c in changed_elements[:20])
        if sse:
            sse({
                "type": "figma_changes",
                "count": len(changed_elements),
                "changes": changed_elements,
            })
            sse({"type": "text_delta", "content": f"  ⚡ Figma changed ({len(changed_elements)} element(s)):\n{change_lines}\n"})
    else:
        if sse:
            sse({"type": "text_delta", "content": "  ✅ Figma re-imported — no design changes detected.\n"})

    return state


async def context_ratio_hil(state: Phase1State) -> Phase1State:
    """
    T-P1-07: HIL gate — show token context ratio before Figma load + file generation.

    Computes:
      • new_pct  = fraction of context coming from Q&A answers + user prompt
      • exist_pct = fraction coming from existing codebase analysis

    In YOLO mode: auto-proceeds with a text summary.
    In HIL mode:  emits a 'choice_request' SSE and waits for the user to choose
                  one of: proceed / ask_more / reduce_existing / end_phase1.

    The choice is stored in state['context_ratio_choice'] so downstream nodes
    can adapt (e.g. generate_files skips codebase block when 'reduce_existing').
    """
    sse = state.get("send_sse")
    is_yolo = state.get("is_yolo", False)
    _input_queue = state.get("_input_queue")

    # ── Token estimation (word-count × 1.3 ≈ rough token count) ──────────────
    prompt_text = state.get("user_prompt", "")
    qa_answers = state.get("qa_answers", {})
    codebase_summary = state.get("existing_codebase_summary", "")
    research_ctx = state.get("research_context", "")

    def _wtok(text: str) -> int:
        return max(1, int(len(text.split()) * 1.3))

    new_tokens  = _wtok(prompt_text) + _wtok(json.dumps(qa_answers))
    exist_tokens = _wtok(codebase_summary) + _wtok(research_ctx)
    total_tokens = new_tokens + exist_tokens

    new_pct   = round(new_tokens  / total_tokens * 100)
    exist_pct = 100 - new_pct

    # ── Bar visualisation ─────────────────────────────────────────────────────
    bar_width  = 20
    new_bars   = round(new_pct   / 100 * bar_width)
    exist_bars = bar_width - new_bars
    bar_str    = "█" * new_bars + "░" * exist_bars

    summary_line = (
        f"Context breakdown: [{bar_str}] "
        f"{new_pct}% new ({new_tokens:,} tok) / "
        f"{exist_pct}% existing ({exist_tokens:,} tok) — "
        f"total ≈ {total_tokens:,} tokens"
    )

    if is_yolo or _input_queue is None:
        # YOLO: just emit info and move on
        if sse:
            sse({"type": "text_delta", "content": f"\n📊 {summary_line}\n"})
        state["context_ratio_choice"] = "proceed"
        return state

    # HIL: emit choice_request with ratio information
    if sse:
        sse({
            "type": "choice_request",
            "id": "context_ratio",
            "question": (
                f"{summary_line}\n\n"
                "How would you like to proceed with planning file generation?"
            ),
            "can_end": True,
            "options": [
                {
                    "id": "proceed",
                    "text": "Proceed — generate all planning files now",
                    "description": "Full context: Q&A answers + codebase analysis",
                },
                {
                    "id": "ask_more",
                    "text": "Ask 5 more targeted questions first",
                    "description": "Refine requirements before generating files",
                },
                {
                    "id": "reduce_existing",
                    "text": "Reduce existing-code context",
                    "description": "Focus planning on new requirements; ignore legacy code",
                },
                {
                    "id": "end_phase1",
                    "text": "End Phase 1 with current context",
                    "description": "Generate files immediately without further questions",
                },
            ],
        })

    choice = "proceed"
    if _input_queue is not None:
        try:
            raw = str(await asyncio.wait_for(_input_queue.get(), timeout=120.0)).strip().lower()
            if raw in ("proceed", "ask_more", "reduce_existing", "end_phase1"):
                choice = raw
            elif raw in ("1", "0"):
                choice = "proceed"
            elif raw in ("2",):
                choice = "ask_more"
            elif raw in ("3",):
                choice = "reduce_existing"
            elif raw in ("4",):
                choice = "end_phase1"
        except asyncio.TimeoutError:
            if sse:
                sse({"type": "text_delta", "content": "⏱ No response — proceeding automatically.\n"})

    state["context_ratio_choice"] = choice

    # Handle "ask_more": run 5 extra targeted Q&A rounds inline
    if choice == "ask_more":
        if sse:
            sse({"type": "text_delta", "content": "\n🔍 Generating 5 follow-up questions...\n"})
        extra_prompt = (
            f"The user is building: {prompt_text}\n"
            f"They already answered:\n{json.dumps(qa_answers, indent=2)}\n\n"
            "Generate 5 highly targeted follow-up questions to clarify remaining ambiguities. "
            "Format as JSON array: [{\"question\": \"...\", \"options\": [\"A\",\"B\",\"C\",\"None/Skip\"], "
            "\"default_answer\": \"A\"}]"
        )
        import re as _re2
        raw_extra = await _llm_call([{"role": "user", "content": extra_prompt}], max_tokens=1500)
        extra_qs: list[dict] = []
        try:
            m = _re2.search(r"\[.*\]", raw_extra, _re2.DOTALL)
            if m:
                extra_qs = json.loads(m.group())[:5]
        except Exception:
            pass

        for idx, qobj in enumerate(extra_qs):
            question_text = qobj.get("question", f"Follow-up question {idx + 1}")
            options       = qobj.get("options", ["Yes", "No", "None of the above / Skip"])
            default_ans   = qobj.get("default_answer", options[0] if options else "")
            if sse:
                sse({
                    "type": "choice_request",
                    "id": f"extra_qa_{idx}",
                    "question": question_text,
                    "options": [{"id": str(i), "text": o} for i, o in enumerate(options)],
                    "can_end": False,
                })
            if _input_queue is not None:
                try:
                    ans_raw = str(await asyncio.wait_for(_input_queue.get(), timeout=90.0)).strip()
                    if ans_raw.isdigit():
                        idx_int = int(ans_raw)
                        answer = options[idx_int] if 0 <= idx_int < len(options) else default_ans
                    else:
                        answer = ans_raw or default_ans
                except asyncio.TimeoutError:
                    answer = default_ans
            else:
                answer = default_ans
            qa_answers[f"extra_{idx + 1}: {question_text[:60]}"] = answer

        state["qa_answers"] = qa_answers

    # Handle "reduce_existing": trim the codebase summary to 20% of original
    if choice == "reduce_existing":
        if codebase_summary:
            trimmed_len = max(200, len(codebase_summary) // 5)
            state["existing_codebase_summary"] = (
                codebase_summary[:trimmed_len]
                + f"\n\n[...codebase context trimmed per user request — {exist_pct}% → ~4% of total context...]"
            )
        if sse:
            sse({"type": "text_delta", "content": "✂️  Existing codebase context reduced.\n"})

    return state


async def generate_files(state: Phase1State) -> Phase1State:
    """Node: Generate all 12 phase-1 output files in order."""
    sse = state.get("send_sse")
    project_dir = pathlib.Path(state.get("project_dir", "."))
    phase1_dir = get_phase_dir(project_dir, 1)
    phase1_dir.mkdir(parents=True, exist_ok=True)

    # Context
    prompt = state.get("user_prompt", "")
    qa = state.get("qa_answers", {})
    research = state.get("research_context", "")
    figma = state.get("figma_data")
    codebase = state.get("existing_codebase_summary", "")
    skills_md = state.get("skills_md", "")

    # Generate agent-skills.md first
    skills_finder = AgentSkillsFinder()
    skills_out = str(phase1_dir / "agent-skills.md")
    skills_finder.write_skills_md(skills_out, prompt)
    state["skills_md"] = pathlib.Path(skills_out).read_text()

    # Compute context budget — HIL: let user choose allocation percentage
    total_ctx = 200_000  # default; real value passed in via state
    user_pct: float | None = None

    if not state.get("is_yolo", False):
        _input_queue = state.get("_input_queue")
        if sse:
            sse(ContextBudget.build_choice_request(state.get("is_new_project", True)))
        if _input_queue is not None:
            try:
                raw_answer = str(await asyncio.wait_for(_input_queue.get(), timeout=120.0))
                if raw_answer.isdigit():
                    user_pct = int(raw_answer) / 100.0
                elif raw_answer not in ("auto", ""):
                    # Try "custom" — treat raw number string like "70"
                    try:
                        user_pct = float(raw_answer.replace("%", "").strip()) / 100.0
                    except ValueError:
                        user_pct = None
            except asyncio.TimeoutError:
                user_pct = None  # auto-assign on timeout

    budget = ContextBudget(
        total_context=state.get("_total_context", total_ctx),  # type: ignore
        is_new_project=state.get("is_new_project", True),
        user_allocated_pct=user_pct,
    )
    budget.write_context_management_md(str(phase1_dir / "context_management.md"))

    # Build system context for file generation
    context_block = f"""User request: {prompt}

Q&A Answers:
{json.dumps(qa, indent=2)}

Research context:
{research[:1000]}

Existing codebase:
{codebase}

Figma design:
{json.dumps(figma, indent=2) if figma else 'None provided'}
"""

    generated: dict[str, str] = {}

    # Initialize Mem0 client for storing file summaries (T-A02)
    mem = None
    try:
        mem = Mem0Client(
            state.get("user_id", "anonymous"),
            hashlib.sha256(state.get("project_dir", ".").encode()).hexdigest()[:8],
        )
    except Exception:
        pass

    files_to_generate = [f for f in PHASE1_FILES if f not in ("agent-skills.md", "context_management.md", "phase-1.md")]
    files_to_generate = [f for f in PHASE1_FILES if f not in ("agent-skills.md", "context_management.md", "phase-1.md")]

    for filename in files_to_generate:
        out_path = phase1_dir / filename

        # ── Idempotent auto-fill: skip files that already have substantive content ──
        if _should_skip_doc(out_path):
            if sse:
                sse({"type": "text_delta", "content": f"⏩ Skipping {filename} (already complete)\n"})
            generated[filename] = out_path.read_text()
            continue

        if sse:
            sse({"type": "text_delta", "content": f"📝 Generating {filename}...\n"})

        content = await _generate_file(filename, context_block)
        out_path.write_text(content)
        generated[filename] = content

        # Store file summary in Mem0 (T-A02)
        if mem:
            summary = content[:500] if len(content) > 500 else content
            mem.add(
                f"Phase 1 planning file: {filename}\n{summary}",
                metadata={"type": "planning_file", "phase": "1", "filename": filename},
            )
        out_path.write_text(content)
        generated[filename] = content

    # Generate phase-1.md LAST
    phase1_md_path = phase1_dir / "phase-1.md"
    if _should_skip_doc(phase1_md_path):
        if sse:
            sse({"type": "text_delta", "content": "⏩ Skipping phase-1.md (already complete)\n"})
        generated["phase-1.md"] = phase1_md_path.read_text()
    else:
        if sse:
            sse({"type": "text_delta", "content": "📋 Generating phase-1.md (summary)...\n"})
        phase1_summary = await _generate_file("phase-1.md", context_block, extra_instruction="This is the final summary of Phase 1. Include links to all other generated files.")
        phase1_md_path.write_text(phase1_summary)
        generated["phase-1.md"] = phase1_summary

        # Store phase-1.md summary in Mem0 (T-A02)
        if mem:
            mem.add(
                f"Phase 1 complete summary: {phase1_summary[:500]}",
                metadata={"type": "planning_summary", "phase": "1", "filename": "phase-1.md"},
            )
        phase1_md_path.write_text(phase1_summary)
        generated["phase-1.md"] = phase1_summary

    state["generated_files"] = generated

    # Record file generation in cross-phase registry
    project_dir_str = str(project_dir)
    record_decision(
        project_dir_str,
        phase=1,
        decision_type="phase_output",
        description=f"Phase 1 planning complete — generated {len(generated)} documents",
        source_file="phase-1/phase-1.md",
        metadata={"files": list(generated.keys())},
    )

    return state


def _should_skip_doc(path: pathlib.Path, min_chars: int = 300) -> bool:
    """
    Return True when a planning doc already has substantive content and should
    NOT be overwritten on a re-run (idempotent phase-1 auto-fill).

    A file is considered "complete" when it:
    - exists on disk, AND
    - contains at least `min_chars` non-whitespace characters, AND
    - does NOT start with a stub/skeleton marker (<!-- TODO --> / # TODO).
    """
    if not path.exists():
        return False
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False

    stripped = content.strip()
    if len(stripped) < min_chars:
        return False

    # Stub-marker detection: skip (regenerate) when stubs are present
    stub_markers = ("<!-- TODO", "# TODO", "# PLACEHOLDER", "<!-- PLACEHOLDER", "TBD", "[TODO]")
    first_1k = stripped[:1000].upper()
    if any(m.upper() in first_1k for m in stub_markers):
        return False

    return True


async def _generate_file(filename: str, context: str, extra_instruction: str = "") -> str:
    """Generate a single planning document using LLM with rich, structured prompts."""

    # -----------------------------------------------------------------------
    # Per-file system + user prompt templates
    # -----------------------------------------------------------------------
    if filename == "user-stories.md":
        system_prompt = (
            "You are a senior product manager. Generate detailed user stories with proper IDs, "
            "explicit Actor/Goal/Reason fields, numbered sub-stories, acceptance criteria, "
            "and test scenarios. Follow the exact format specified — do not deviate."
        )
        user_prompt = f"""Generate a comprehensive user-stories.md file for this project.

## Project Context
{context}

## MANDATORY Format for Every User Story
Each story MUST use this exact structure (T-P1-05 compliance):

---
### US-001 · <Short Title>

| Field       | Value                                     |
|-------------|-------------------------------------------|
| **Actor**   | <primary user role, e.g. "Guest User">    |
| **Goal**    | <what the actor wants to accomplish>      |
| **Reason**  | <business/user value — "so that …">       |
| **Priority**| High \\| Medium \\| Low                   |
| **Status**  | TODO                                      |

**Story**: As a <Actor>, I want to <Goal> so that <Reason>.

**Sub-stories** (numbered, if the story is complex):
1. US-001.1 — <sub-story description>
2. US-001.2 — <sub-story description>

**Acceptance Criteria**:
- AC-1: <concrete, testable criterion>
- AC-2: <concrete, testable criterion>
- AC-3: <concrete, testable criterion>

**Test Scenarios**:
- TS-1: Given <precondition>, when <action>, then <expected result>
- TS-2: Given <precondition>, when <action>, then <expected result>

**Dependencies**: US-XXX, US-YYY (or "None")
---

## Quantity Guidelines
- Small/simple project: 5–15 stories
- Medium project: 15–25 stories
- Complex/large project: 25+ stories (up to US-050 or beyond)

## Grouping
Group stories under H2 section headings:
- ## Core Features
- ## Authentication & Authorisation
- ## UI / UX
- ## Integrations & APIs
- ## Admin & Settings
- ## Non-functional (Performance, Security, Accessibility)

## Critical Rules
1. IDs MUST be zero-padded 3-digit: US-001, US-002 … US-00N
2. Sub-story IDs use dot notation: US-003.1, US-003.2
3. Actor MUST be a named role (not "user" generically)
4. Every story needs at least 3 ACs and 2 TSs
5. Dependencies MUST reference valid US-IDs from this document

Generate the full user-stories.md now:"""

    elif filename == "tasks.md":
        system_prompt = (
            "You are a senior software engineer creating a structured task breakdown. "
            "Use T-001, T-002... IDs. Each task must reference its US-IDs if applicable."
        )
        user_prompt = f"""Generate a detailed tasks.md file.

## Project Context
{context}

## Format Requirements
- Task IDs: T-001, T-002 ... T-00N
- Each task: ID, Title, Phase (1-6), Priority (P0/P1/P2), Status (TODO), Estimate (hours), 
  Description, Related US-IDs, Dependencies (other T-IDs)
- Group tasks by Phase
- Minimum 15 tasks for small projects, 30+ for large ones

Generate the full tasks.md now:"""

    elif filename == "plan.md":
        system_prompt = "You are a senior software architect writing an executive project plan."
        user_prompt = f"""Generate a comprehensive plan.md.

## Project Context
{context}

## Required Sections
1. Executive Summary
2. Project Overview & Goals
3. Tech Stack (with version numbers)
4. System Architecture (describe layers)
5. Milestones & Timeline (Phase 1-6 with estimated durations)
6. Team Structure & Responsibilities
7. Success Metrics (KPIs)
8. Out of Scope

Generate the full plan.md now:"""

    elif filename == "design.md":
        system_prompt = "You are a senior UI/UX designer writing a detailed design specification."
        user_prompt = f"""Generate a design.md file with distinctive, production-grade aesthetics.

## Project Context
{context}

## Required Sections
1. Design Philosophy & Brand Identity
2. Color Palette (with hex codes — primary, secondary, accent, backgrounds, text)
3. Typography (font families, sizes, weights for headings/body/code)
4. Component Library (Tailwind CSS + shadcn/ui — list specific components to use)
5. Layout & Spacing System (grid, breakpoints)
6. Page List (enumerate every page/screen with its purpose)
7. Navigation Structure (routes hierarchy)
8. Interaction Patterns (hover, focus, transitions)
9. Dark/Light Mode strategy
10. Responsive Design breakpoints

## Design Thinking Guidelines
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

## Frontend Aesthetics Guidelines
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Focus on high-impact moments with staggered reveals.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth. Add contextual effects and textures. Apply gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows.

## NEVER Use Generic AI Aesthetics
- Overused font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character

Be specific. Include real hex codes, font names, and exact component names.
Generate the full design.md now:"""

    elif filename == "prd.md":
        system_prompt = "You are a senior product manager writing a Product Requirements Document."
        user_prompt = f"""Generate a prd.md file.

## Project Context
{context}

## Required Sections
1. Product Vision
2. Problem Statement
3. Target Users (personas)
4. Functional Requirements (FR-001...FR-00N)
5. Non-Functional Requirements (NFR-001...NFR-00N — performance, security, scalability)
6. MVP Scope vs Future Scope
7. Integration Requirements
8. Compliance & Security Requirements
9. Analytics & Monitoring Requirements
10. Rollout Plan

Generate the full prd.md now:"""

    elif filename == "technical-spec.md":
        system_prompt = "You are a senior software architect writing a technical specification."
        user_prompt = f"""Generate a technical-spec.md file.

## Project Context
{context}

## Required Sections
1. Architecture Overview (diagram description)
2. Frontend Architecture (components, state management, routing)
3. Backend Architecture (services, controllers, middleware)
4. Database Design (tables/collections, relationships, indexes)
5. API Specification (REST endpoints with method, path, request/response schemas)
6. Authentication & Authorization Flow
7. Third-Party Integrations (with API versions)
8. Caching Strategy
9. Error Handling Strategy
10. Deployment Architecture (environments, CI/CD)
11. Data Flow Diagrams (described in text)
12. Security Considerations

Generate the full technical-spec.md now:"""

    elif filename == "risk-assessment.md":
        system_prompt = "You are a senior project manager writing a risk assessment."
        user_prompt = f"""Generate a risk-assessment.md file.

## Project Context
{context}

## Required Sections
1. Risk Matrix (for each risk: ID, Category, Description, Likelihood, Impact, Severity, Mitigation, Owner)
2. Technical Risks (RISK-T-001...)
3. Business Risks (RISK-B-001...)
4. Timeline Risks (RISK-TL-001...)
5. Security Risks (RISK-S-001...)
6. Dependency Risks (RISK-D-001...)
7. Risk Monitoring Plan
8. Contingency Plans for Top 3 risks

Minimum 10 risks. Use a markdown table for the risk matrix.
Generate the full risk-assessment.md now:"""

    elif filename == "competitive-analysis.md":
        system_prompt = "You are a product strategist writing a competitive analysis."
        user_prompt = f"""Generate a competitive-analysis.md file.

## Project Context
{context}

## Required Sections
1. Market Overview
2. Competitor Matrix (table: Competitor, Pricing, Key Features, Strengths, Weaknesses, Market Share)
3. Feature Comparison Table (our app vs top 3-5 competitors)
4. Differentiation Strategy
5. Market Gaps & Opportunities
6. Positioning Statement
7. SWOT Analysis

Identify at least 5 real or plausible competitors.
Generate the full competitive-analysis.md now:"""

    elif filename == "constraints-and-tradeoffs.md":
        system_prompt = "You are a senior architect documenting engineering constraints and tradeoffs."
        user_prompt = f"""Generate a constraints-and-tradeoffs.md file.

## Project Context
{context}

## Required Sections
1. Technical Constraints (C-T-001...C-T-00N)
2. Business Constraints (C-B-001...C-B-00N)
3. Resource Constraints
4. Time Constraints
5. Key Tradeoff Decisions (for each: Decision ID, Options Considered, Choice Made, Rationale, Implications)
6. Technology Debt Acknowledgements
7. Assumptions and Dependencies

Minimum 8 constraints and 5 tradeoff decisions.
Generate the full constraints-and-tradeoffs.md now:"""

    elif filename == "phase-1.md":
        system_prompt = "You are a senior project lead writing a phase completion summary."
        user_prompt = f"""Generate a phase-1.md summary document.

## Project Context
{context}

{extra_instruction}

## Required Sections
1. Phase 1 Completion Summary
2. Key Decisions Made
3. Files Generated (list all 12 files with one-line description each)
4. Q&A Session Summary (key answers that shaped the plan)
5. Tech Stack Confirmed
6. Risks Identified (top 3)
7. Readiness for Phase 2 Checklist
8. Next Steps (Phase 2 actions)

Generate the full phase-1.md now:"""

    else:
        system_prompt = "You are a senior software architect creating planning documents. Be specific and detailed. Use markdown formatting."
        user_prompt = f"""Generate the {filename} document.

## Project Context
{context}

{extra_instruction if extra_instruction else ""}

Generate the full {filename} document:"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return await _llm_call(messages, max_tokens=4096)


# ------------------------------------------------------------------
# Graph assembly
# ------------------------------------------------------------------

def build_phase1_graph() -> Any:
    """Build and compile the Phase 1 LangGraph StateGraph."""
    if not LANGGRAPH_AVAILABLE:
        return None

    graph = StateGraph(Phase1State)

    graph.add_node("research_web", research_web)
    graph.add_node("check_existing_codebase", check_existing_codebase)
    graph.add_node("qa_loop", qa_loop)
    graph.add_node("context_ratio_hil", context_ratio_hil)  # T-P1-07
    graph.add_node("load_figma", load_figma)
    graph.add_node("generate_files", generate_files)

    graph.set_entry_point("research_web")
    graph.add_edge("research_web", "check_existing_codebase")
    graph.add_edge("check_existing_codebase", "qa_loop")
    graph.add_edge("qa_loop", "context_ratio_hil")          # T-P1-07
    graph.add_edge("context_ratio_hil", "load_figma")       # T-P1-07
    graph.add_edge("load_figma", "generate_files")
    graph.add_edge("generate_files", END)

    return graph.compile()


# ------------------------------------------------------------------
# Entry point (called from bridge)
# ------------------------------------------------------------------

async def run_phase1(
    user_prompt: str,
    project_dir: str,
    user_id: str = "anonymous",
    is_yolo: bool = False,
    figma_url: str | None = None,
    send_sse: Any = None,
    input_queue: Any = None,
) -> dict[str, Any]:
    """
    Run Phase 1 planning agent.
    Returns dict with generated_files, qa_answers, and status.
    """
    if send_sse is None:
        send_sse = lambda evt: None  # noqa: E731

    initial_state: Phase1State = {
        "user_prompt": user_prompt,
        "project_dir": project_dir,
        "user_id": user_id,
        "is_yolo": is_yolo,
        "figma_url": figma_url,
        "send_sse": send_sse,
        "_input_queue": input_queue,  # type: ignore
    }

    graph = build_phase1_graph()
    if graph is None:
        # Fallback: run nodes manually without LangGraph
        state = initial_state
        for node_fn in [research_web, check_existing_codebase, qa_loop, context_ratio_hil, load_figma, generate_files]:
            state = await node_fn(state)  # type: ignore[arg-type]
    else:
        state = await graph.ainvoke(initial_state)

    send_sse({"type": "phase_complete", "phase": 1, "files": list(state.get("generated_files", {}).keys())})

    return {
        "status": "complete",
        "generated_files": list(state.get("generated_files", {}).keys()),
        "qa_answers": state.get("qa_answers", {}),
        "is_new_project": state.get("is_new_project", True),
    }
