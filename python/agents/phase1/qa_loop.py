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
    is_frontend = any(kw in prompt_lower for kw in ["frontend", "website", "web app", "landing page", "dashboard", "ui", "site"])
    is_backend = any(kw in prompt_lower for kw in ["backend", "api", "server", "database", "rest"])
    is_fullstack = any(kw in prompt_lower for kw in ["fullstack", "full stack", "complete"])

    # Determine project type
    if is_mobile:
        project_type = "mobile application"
    elif is_backend and not is_frontend:
        project_type = "backend API"
    elif is_frontend:
        project_type = "frontend website"
    else:
        project_type = "web application"

    # AI-generated questions prompt - context-aware
    questions_prompt = f"""You are a senior software architect. A user wants to build: "{prompt_text}"

This appears to be a {project_type}. Generate exactly 10 clarifying questions to understand the requirements.

Requirements:
1. Questions must be RELEVANT to the type of project ({project_type})
2. Each question must have exactly 4 single-select answer options
3. The LAST option must always be "None of the above / Skip"
4. Make questions specific to this project type - avoid generic questions

For a mobile app, ask about: iOS/Android, push notifications, offline support, app store
For a website, ask about: browsers, responsive design, SEO, authentication, integrations
For a backend API, ask about: language, database, auth, caching, deployment

Format as JSON array:
[{{"question": "Question text?", "options": ["Option A", "Option B", "Option C", "None of the above / Skip"], "default_answer": "Option A"}}]

Return ONLY valid JSON array, no extra text."""

    raw_questions = await _llm_call(
        [{"role": "user", "content": questions_prompt}],
        max_tokens=2500,
    )

    # Parse AI-generated questions
    questions = []
    try:
        import re
        match = re.search(r"\[.*\]", raw_questions, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
            if isinstance(parsed, list) and len(parsed) > 0:
                questions = parsed
    except (json.JSONDecodeError, Exception):
        pass

    # T-CLI-18: Guarantee at LEAST 10 questions for vague/complex prompts.
    # If AI returned fewer than 10, top up from fallback bank below.
    MIN_QUESTIONS = 10
    # Context-aware fallback questions if AI fails
    if not questions:
        if is_mobile:
            questions = [
                {"question": "Which platforms should the app support?", "options": ["iOS only", "Android only", "Both iOS and Android", "None of the above / Skip"], "default_answer": "Both iOS and Android"},
                {"question": "Do you need push notifications?", "options": ["Yes, with Firebase", "Yes, with custom server", "No notifications needed", "None of the above / Skip"], "default_answer": "Yes, with Firebase"},
                {"question": "Should the app work offline?", "options": ["Full offline support", "Partial offline (cached data)", "Online only", "None of the above / Skip"], "default_answer": "Partial offline (cached data)"},
                {"question": "What state management solution?", "options": ["Redux/Zustand", "Context API", "No complex state needed", "None of the above / Skip"], "default_answer": "Redux/Zustand"},
                {"question": "Need device permissions (camera, location)?", "options": ["Camera and location", "Location only", "No special permissions", "None of the above / Skip"], "default_answer": "Location only"},
                {"question": "App authentication method?", "options": ["Social login (Google/Apple)", "Email/password", "No authentication", "None of the above / Skip"], "default_answer": "Social login (Google/Apple)"},
                {"question": "Need in-app purchases?", "options": ["Yes, subscriptions", "Yes, one-time purchases", "No payments", "None of the above / Skip"], "default_answer": "No payments"},
                {"question": "Target iOS version?", "options": ["Latest only", "Last 2 versions", "No iOS requirement", "None of the above / Skip"], "default_answer": "Last 2 versions"},
                {"question": "Analytics requirements?", "options": ["Firebase Analytics", "Custom analytics", "No analytics", "None of the above / Skip"], "default_answer": "Firebase Analytics"},
                {"question": "App icon and assets?", "options": ["Need design service", "I have assets ready", "Use defaults", "None of the above / Skip"], "default_answer": "Use defaults"},
            ]
        elif is_frontend:
            questions = [
                {"question": "Which framework?", "options": ["Next.js", "React", "Vue/Nuxt", "None of the above / Skip"], "default_answer": "Next.js"},
                {"question": "Styling approach?", "options": ["Tailwind CSS", "Styled Components", "CSS Modules", "None of the above / Skip"], "default_answer": "Tailwind CSS"},
                {"question": "Authentication needed?", "options": ["Yes (OAuth)", "Yes (email/password)", "No auth needed", "None of the above / Skip"], "default_answer": "Yes (OAuth)"},
                {"question": "Target browsers?", "options": ["Modern browsers only", "Last 2 versions", "IE11 support", "None of the above / Skip"], "default_answer": "Modern browsers only"},
                {"question": "SEO requirements?", "options": ["Full SEO optimization", "Basic meta tags", "No SEO needed", "None of the above / Skip"], "default_answer": "Full SEO optimization"},
                {"question": "State management?", "options": ["Redux/Zustand", "React Query", "Context only", "None of the above / Skip"], "default_answer": "React Query"},
                {"question": "Need real-time features?", "options": ["WebSockets", "Server-Sent Events", "No real-time", "None of the above / Skip"], "default_answer": "No real-time"},
                {"question": "Forms and validation?", "options": ["React Hook Form", "Formik", "Native forms", "None of the above / Skip"], "default_answer": "React Hook Form"},
                {"question": "Testing requirements?", "options": ["Full test suite", "Unit tests only", "No tests", "None of the above / Skip"], "default_answer": "Unit tests only"},
                {"question": "Deployment target?", "options": ["Vercel", "Netlify", "Self-hosted", "None of the above / Skip"], "default_answer": "Vercel"},
            ]
        elif is_backend:
            questions = [
                {"question": "Which language/framework?", "options": ["Node.js/Express", "Python/FastAPI", "Go", "None of the above / Skip"], "default_answer": "Node.js/Express"},
                {"question": "Database preference?", "options": ["PostgreSQL", "MongoDB", "MySQL", "None of the above / Skip"], "default_answer": "PostgreSQL"},
                {"question": "Authentication method?", "options": ["JWT tokens", "Session-based", "OAuth2", "None of the above / Skip"], "default_answer": "JWT tokens"},
                {"question": "API style?", "options": ["REST", "GraphQL", "gRPC", "None of the above / Skip"], "default_answer": "REST"},
                {"question": "Need caching?", "options": ["Redis", "Memcached", "No caching", "None of the above / Skip"], "default_answer": "Redis"},
                {"question": "Message queue?", "options": ["RabbitMQ", "Kafka", "None needed", "None of the above / Skip"], "default_answer": "None needed"},
                {"question": "File storage?", "options": ["S3-compatible", "Local storage", "Cloudinary", "None of the above / Skip"], "default_answer": "S3-compatible"},
                {"question": "Background jobs?", "options": ["Celery/Bull", "Cron jobs", "No background jobs", "None of the above / Skip"], "default_answer": "Cron jobs"},
                {"question": "API documentation?", "options": ["Swagger/OpenAPI", "Postman collection", "No docs", "None of the above / Skip"], "default_answer": "Swagger/OpenAPI"},
                {"question": "Deployment?", "options": ["Docker/Kubernetes", "Serverless", "Traditional server", "None of the above / Skip"], "default_answer": "Docker/Kubernetes"},
            ]
        else:
            questions = [
                {"question": "What is the primary tech stack?", "options": ["React/Next.js", "Vue/Nuxt", "Svelte/SvelteKit", "None of the above / Skip"], "default_answer": "React/Next.js"},
                {"question": "What database will be used?", "options": ["PostgreSQL", "MySQL", "MongoDB", "None of the above / Skip"], "default_answer": "PostgreSQL"},
                {"question": "Is authentication required?", "options": ["Yes (OAuth)", "Yes (email)", "No", "None of the above / Skip"], "default_answer": "Yes (OAuth)"},
                {"question": "What is the deployment target?", "options": ["Vercel", "AWS", "Docker/K8s", "None of the above / Skip"], "default_answer": "Vercel"},
                {"question": "Do you need real-time features?", "options": ["WebSockets", "Server-Sent Events", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "What is expected user scale?", "options": ["<1K", "1K-10K", "10K+", "None of the above / Skip"], "default_answer": "<1K"},
                {"question": "Do you need payment processing?", "options": ["Stripe", "PayPal", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "What styling approach?", "options": ["Tailwind CSS", "Styled Components", "CSS Modules", "None of the above / Skip"], "default_answer": "Tailwind CSS"},
                {"question": "Do you need analytics?", "options": ["Google Analytics", "Custom", "None", "None of the above / Skip"], "default_answer": "None"},
                {"question": "Any third-party APIs?", "options": ["None required", "AI/LLM APIs", "Social APIs", "None of the above / Skip"], "default_answer": "None required"},
            ]

    # T-CLI-18: If AI returned < 10 questions, top up with universal fallback questions.
    UNIVERSAL_TOPUP = [
        {"question": "Should the project include automated tests?", "options": ["Full test suite (unit + e2e)", "Unit tests only", "No tests for now", "None of the above / Skip"], "default_answer": "Unit tests only"},
        {"question": "What CI/CD pipeline should be used?", "options": ["GitHub Actions", "GitLab CI", "Docker-based", "None of the above / Skip"], "default_answer": "GitHub Actions"},
        {"question": "Is internationalization (i18n) required?", "options": ["Yes, multiple languages", "English only but prep for i18n", "No i18n needed", "None of the above / Skip"], "default_answer": "No i18n needed"},
        {"question": "What logging/monitoring approach?", "options": ["Datadog/NewRelic", "Sentry error tracking", "Console logs only", "None of the above / Skip"], "default_answer": "Sentry error tracking"},
        {"question": "Do you need dark mode?", "options": ["Yes, system-based toggle", "Yes, manual toggle", "Light mode only", "None of the above / Skip"], "default_answer": "Yes, system-based toggle"},
    ]
    if len(questions) < MIN_QUESTIONS:
        existing_texts = {q.get("question", "") for q in questions}
        for topup_q in UNIVERSAL_TOPUP:
            if len(questions) >= MIN_QUESTIONS:
                break
            if topup_q["question"] not in existing_texts:
                questions.append(topup_q)

    answers: dict[str, str] = {}
    mem = None
    try:
        mem = Mem0Client(
            state.get("user_id", "anonymous"),
            hashlib.sha256(state.get("project_dir", ".").encode()).hexdigest()[:8],
        )
    except Exception:
        pass

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
                    "can_end": True,
                    "end_label": f"End phase 1 and start phase 2 (skip remaining {len(questions) - i - 1} questions)",
                }
                sse(event)
            # Await input via asyncio Event (set by phase manager)
            answer = await _await_user_input(state, question_index=i, default=default)

        if answer.startswith("End phase"):
            break

        answers[question] = answer

        if mem:
            mem.store_qa(question, answer)

    state["qa_answers"] = answers
    return state
