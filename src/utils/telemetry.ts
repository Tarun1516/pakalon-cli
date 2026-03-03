/**
 * telemetry.ts — OpenTelemetry instrumentation for the Pakalon CLI
 *
 * T-CLI-OTEL: Implements OpenTelemetry tracing and metrics export,
 * matching the Claude Code CLAUDE_CODE_ENABLE_TELEMETRY env var convention.
 *
 * Activation:
 *   PAKALON_ENABLE_TELEMETRY=1        — enable OTEL
 *   PAKALON_OTEL_ENDPOINT=<url>       — OTLP HTTP/gRPC endpoint (default: http://localhost:4318)
 *   PAKALON_OTEL_SERVICE_NAME=<name>  — service name (default: "pakalon-cli")
 *   PAKALON_OTEL_HEADERS=<key=val>    — optional OTLP auth headers (comma-separated)
 *
 * Spans emitted:
 *   - pakalon.session.start / end
 *   - pakalon.ai.stream (model, tokens, latency)
 *   - pakalon.tool.call (toolName, success, durationMs)
 *   - pakalon.agent.phase (phase, success, durationMs)
 *   - pakalon.command (name)
 *
 * Metrics emitted:
 *   - pakalon.tokens.prompt   (counter, by model)
 *   - pakalon.tokens.completion (counter, by model)
 *   - pakalon.tool.calls      (counter, by toolName)
 *   - pakalon.session.count   (counter)
 *   - pakalon.stream.latency  (histogram, ms)
 */

import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetrySpanOptions {
  attributes?: Record<string, string | number | boolean>;
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface TelemetryMetrics {
  incrementCounter(name: string, value?: number, attrs?: Record<string, string>): void;
  recordHistogram(name: string, value: number, attrs?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// OTEL initialisation (lazy — only when PAKALON_ENABLE_TELEMETRY=1)
// ---------------------------------------------------------------------------

let _initialized = false;
let _tracerProvider: unknown = null;
let _meterProvider: unknown = null;
let _tracer: { startSpan: (name: string, opts?: unknown) => unknown } | null = null;
let _meter: {
  createCounter: (name: string, opts?: unknown) => { add: (val: number, attrs?: unknown) => void };
  createHistogram: (name: string, opts?: unknown) => { record: (val: number, attrs?: unknown) => void };
} | null = null;

export function isEnabled(): boolean {
  return (
    process.env.PAKALON_ENABLE_TELEMETRY === "1" ||
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1"
  );
}

export async function initTelemetry(): Promise<void> {
  if (_initialized || !isEnabled()) return;
  _initialized = true;

  const endpoint =
    process.env.PAKALON_OTEL_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://localhost:4318";

  const serviceName =
    process.env.PAKALON_OTEL_SERVICE_NAME ??
    process.env.OTEL_SERVICE_NAME ??
    "pakalon-cli";

  // Parse optional auth headers (KEY=VALUE,KEY2=VALUE2)
  const headersRaw = process.env.PAKALON_OTEL_HEADERS ?? "";
  const extraHeaders: Record<string, string> = {};
  for (const pair of headersRaw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k && rest.length) extraHeaders[k.trim()] = rest.join("=").trim();
  }

  try {
    // Dynamic import — avoids hard dependency; graceful failure if not installed
    const { NodeTracerProvider } = await import("@opentelemetry/sdk-node" as string);
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http" as string);
    const { Resource } = await import("@opentelemetry/resources" as string);
    const { SEMRESATTRS_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions" as string);
    const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base" as string);
    const { trace } = await import("@opentelemetry/api" as string);
    const { MeterProvider } = await import("@opentelemetry/sdk-metrics" as string);
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http" as string);
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics" as string);
    const { metrics } = await import("@opentelemetry/api" as string);

    const resource = new (Resource as new (attrs: Record<string, string>) => unknown)({
      [(SEMRESATTRS_SERVICE_NAME as unknown as string)]: serviceName,
      "pakalon.version": (await import("../../package.json", { assert: { type: "json" } }) as { default: { version: string } }).default.version,
    });

    const traceExporter = new (OTLPTraceExporter as new (config: unknown) => unknown)({
      url: `${endpoint}/v1/traces`,
      headers: extraHeaders,
    });

    const provider = new (NodeTracerProvider as new (config: unknown) => {
      addSpanProcessor: (p: unknown) => void;
      register: () => void;
    })({ resource });
    provider.addSpanProcessor(new (SimpleSpanProcessor as new (e: unknown) => unknown)(traceExporter));
    provider.register();
    _tracerProvider = provider;
    _tracer = (trace as { getTracer: (name: string) => typeof _tracer }).getTracer("pakalon");

    const metricExporter = new (OTLPMetricExporter as new (config: unknown) => unknown)({
      url: `${endpoint}/v1/metrics`,
      headers: extraHeaders,
    });

    const meterProvider = new (MeterProvider as new (config: unknown) => {
      addMetricReader: (r: unknown) => void;
    })({
      resource,
      readers: [
        new (PeriodicExportingMetricReader as new (config: unknown) => unknown)({
          exporter: metricExporter,
          exportIntervalMillis: 30_000,
        }),
      ],
    });
    (metrics as { setGlobalMeterProvider: (p: unknown) => void }).setGlobalMeterProvider(meterProvider);
    _meterProvider = meterProvider;
    _meter = (metrics as { getMeter: (name: string) => typeof _meter }).getMeter("pakalon") as typeof _meter;

    logger.info(`[Telemetry] OpenTelemetry initialized → ${endpoint} (service: ${serviceName})`);
  } catch (err) {
    logger.warn("[Telemetry] OTEL packages not installed — telemetry disabled. Install @opentelemetry/sdk-node to enable.", { err: String(err) });
    _initialized = false;
  }
}

// ---------------------------------------------------------------------------
// Public API — thin wrappers that are no-ops when OTEL is disabled
// ---------------------------------------------------------------------------

/**
 * Start a trace span. Returns a span-like object. Call .end() when done.
 * Safe to call even when OTEL is disabled.
 */
export function startSpan(
  name: string,
  options: TelemetrySpanOptions = {}
): TelemetrySpan {
  const noop: TelemetrySpan = {
    setAttribute: () => {},
    setStatus: () => {},
    end: () => {},
  };

  if (!isEnabled() || !_tracer) return noop;

  try {
    const span = (_tracer.startSpan as (name: string, opts?: { attributes?: Record<string, string | number | boolean> }) => {
      setAttribute: (k: string, v: string | number | boolean) => void;
      setStatus: (s: { code: number }, msg?: string) => void;
      end: () => void;
    })(name, { attributes: options.attributes });

    return {
      setAttribute: (k, v) => span.setAttribute(k, v),
      setStatus: (s, msg) => {
        span.setStatus({ code: s === "ok" ? 1 : 2 }, msg);
      },
      end: () => span.end(),
    };
  } catch {
    return noop;
  }
}

const _counters = new Map<string, { add: (val: number, attrs?: unknown) => void }>();
const _histograms = new Map<string, { record: (val: number, attrs?: unknown) => void }>();

/**
 * Increment an OTEL counter metric.
 */
export function incrementCounter(
  name: string,
  value = 1,
  attrs?: Record<string, string>
): void {
  if (!isEnabled() || !_meter) return;
  try {
    if (!_counters.has(name)) {
      _counters.set(name, _meter.createCounter(name));
    }
    _counters.get(name)!.add(value, attrs);
  } catch { /* ignore */ }
}

/**
 * Record a histogram value (e.g. latency in ms).
 */
export function recordHistogram(
  name: string,
  value: number,
  attrs?: Record<string, string>
): void {
  if (!isEnabled() || !_meter) return;
  try {
    if (!_histograms.has(name)) {
      _histograms.set(name, _meter.createHistogram(name, { unit: "ms" }));
    }
    _histograms.get(name)!.record(value, attrs);
  } catch { /* ignore */ }
}

/**
 * Convenience: record an AI stream call with token usage + latency.
 */
export function recordAiStream(opts: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  success: boolean;
}): void {
  if (!isEnabled()) return;
  const span = startSpan("pakalon.ai.stream", {
    attributes: { model: opts.model, success: opts.success, durationMs: opts.durationMs },
  });
  span.setAttribute("prompt_tokens", opts.promptTokens);
  span.setAttribute("completion_tokens", opts.completionTokens);
  span.setStatus(opts.success ? "ok" : "error");
  span.end();

  incrementCounter("pakalon.tokens.prompt", opts.promptTokens, { model: opts.model });
  incrementCounter("pakalon.tokens.completion", opts.completionTokens, { model: opts.model });
  recordHistogram("pakalon.stream.latency", opts.durationMs, { model: opts.model });
}

/**
 * Convenience: record a tool call.
 */
export function recordToolCall(opts: {
  toolName: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isEnabled()) return;
  const span = startSpan("pakalon.tool.call", {
    attributes: { tool: opts.toolName, success: opts.success, durationMs: opts.durationMs },
  });
  span.setStatus(opts.success ? "ok" : "error");
  span.end();

  incrementCounter("pakalon.tool.calls", 1, { tool: opts.toolName });
}

/**
 * Convenience: record a pipeline phase execution.
 */
export function recordAgentPhase(opts: {
  phase: number;
  phaseName: string;
  durationMs: number;
  success: boolean;
}): void {
  if (!isEnabled()) return;
  const span = startSpan("pakalon.agent.phase", {
    attributes: {
      phase: opts.phase,
      phase_name: opts.phaseName,
      success: opts.success,
      durationMs: opts.durationMs,
    },
  });
  span.setStatus(opts.success ? "ok" : "error");
  span.end();
}

/**
 * Flush all pending spans/metrics before process exit.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!isEnabled()) return;
  try {
    if (_tracerProvider && typeof (_tracerProvider as { shutdown?: () => Promise<void> }).shutdown === "function") {
      await (_tracerProvider as { shutdown: () => Promise<void> }).shutdown();
    }
    if (_meterProvider && typeof (_meterProvider as { shutdown?: () => Promise<void> }).shutdown === "function") {
      await (_meterProvider as { shutdown: () => Promise<void> }).shutdown();
    }
    logger.info("[Telemetry] Flushed and shut down OTEL SDK");
  } catch (err) {
    logger.warn("[Telemetry] Shutdown error", { err: String(err) });
  }
}
