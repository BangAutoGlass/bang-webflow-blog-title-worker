/*
  Render/GitHub backend worker for Bang AutoGlass Webflow blog title creation.

  Purpose:
  - Keep long-running OpenAI, SERP, and Webflow work out of Supabase Edge Functions.
  - Use Supabase Edge only as a short-lived queue/control API.
  - Claim multiple CSV rows from one queued job and run each row as its own OpenAI request.
  - Default generation behavior is tuned for 25 parallel row-level OpenAI requests.
  - Webflow creation remains intentionally slower and separately configurable.

  Required env for PHASE=generate or PHASE=all:
    EDGE_FUNCTION_URL
    WORKER_SECRET
    OPENAI_API_KEY
    OPENAI_MODEL or best_chatgpt_modal

  Required env for PHASE=webflow or PHASE=all:
    EDGE_FUNCTION_URL
    WORKER_SECRET
    WEBFLOW_API_TOKEN or WEBFLOW_OAUTH_TOKEN

  Common env:
    PHASE=generate | webflow | all
    JOB_ID=optional specific job UUID; leave blank to auto-discover the next queued job
    WORKER_ID=optional worker label
    RESET_STALE_MINUTES=45
    SLEEP_MS=5000
    IDLE_SLEEP_MS=60000
    ERROR_SLEEP_MS=30000
    STOP_ON_ERRORS=false
    KEEP_ALIVE_WHEN_DONE=true

  Generation concurrency env:
    GENERATE_BATCH_SIZE=25
    GENERATE_CONCURRENCY=25
    MAX_GENERATE_BATCH_SIZE=25
    MAX_GENERATE_CONCURRENCY=25

  Webflow concurrency env:
    WEBFLOW_BATCH_SIZE=5
    WEBFLOW_CONCURRENCY=2
    MAX_WEBFLOW_BATCH_SIZE=25
    MAX_WEBFLOW_CONCURRENCY=5

  Backward-compatible env:
    BATCH_SIZE and CONCURRENCY are still honored when phase-specific env values
    are not set. Prefer GENERATE_* and WEBFLOW_* for clear production behavior.

  Optional research env:
    TITLE_RESEARCH_SERP_PROVIDER=auto | serpapi | dataforseo | bing
    SERPAPI_API_KEY
    DATAFORSEO_LOGIN
    DATAFORSEO_PASSWORD
    BING_SEARCH_API_KEY
    BING_SEARCH_ENDPOINT
    SERP_REQUEST_TIMEOUT_SECONDS=15

  Optional OpenAI env:
    OPENAI_TITLE_TIMEOUT_SECONDS=240
    OPENAI_MAX_RETRIES=3
    OPENAI_USE_REASONING=true
    ENABLE_OPENAI_RESEARCH_AUDIT=false
    OPENAI_RESEARCH_TIMEOUT_SECONDS=60
*/

const EDGE_FUNCTION_URL = mustGetEnv("EDGE_FUNCTION_URL")
const WORKER_SECRET = mustGetEnv("WORKER_SECRET")

const JOB_ID = stringEnv("JOB_ID", "")
const PHASE = stringEnv("PHASE", "generate").toLowerCase()
const WORKER_ID = stringEnv("WORKER_ID", `render-${PHASE}-worker`)

const MAX_GENERATE_BATCH_SIZE = numberEnv("MAX_GENERATE_BATCH_SIZE", 25, 1, 1000)
const MAX_GENERATE_CONCURRENCY = numberEnv("MAX_GENERATE_CONCURRENCY", 25, 1, 1000)
const MAX_WEBFLOW_BATCH_SIZE = numberEnv("MAX_WEBFLOW_BATCH_SIZE", 25, 1, 100)
const MAX_WEBFLOW_CONCURRENCY = numberEnv("MAX_WEBFLOW_CONCURRENCY", 5, 1, 25)

const GENERATE_BATCH_SIZE = phaseNumberEnv(
  "GENERATE_BATCH_SIZE",
  "BATCH_SIZE",
  25,
  1,
  MAX_GENERATE_BATCH_SIZE
)
const GENERATE_CONCURRENCY = phaseNumberEnv(
  "GENERATE_CONCURRENCY",
  "CONCURRENCY",
  25,
  1,
  MAX_GENERATE_CONCURRENCY
)
const WEBFLOW_BATCH_SIZE = phaseNumberEnv(
  "WEBFLOW_BATCH_SIZE",
  "BATCH_SIZE",
  5,
  1,
  MAX_WEBFLOW_BATCH_SIZE
)
const WEBFLOW_CONCURRENCY = phaseNumberEnv(
  "WEBFLOW_CONCURRENCY",
  "CONCURRENCY",
  2,
  1,
  MAX_WEBFLOW_CONCURRENCY
)

const BATCH_SIZE = PHASE === "webflow" ? WEBFLOW_BATCH_SIZE : GENERATE_BATCH_SIZE
const CONCURRENCY = PHASE === "webflow" ? WEBFLOW_CONCURRENCY : GENERATE_CONCURRENCY
const RESET_STALE_MINUTES = numberEnv("RESET_STALE_MINUTES", 45, 0, 1440)

const SLEEP_MS = numberEnv("SLEEP_MS", 5000, 250, 300000)
const IDLE_SLEEP_MS = numberEnv("IDLE_SLEEP_MS", 60000, 1000, 900000)
const ERROR_SLEEP_MS = numberEnv("ERROR_SLEEP_MS", 30000, 1000, 900000)
const STOP_ON_ERRORS = boolEnv("STOP_ON_ERRORS", false)
const KEEP_ALIVE_WHEN_DONE = boolEnv("KEEP_ALIVE_WHEN_DONE", true)

const OPENAI_API_KEY = envValue("OPENAI_API_KEY")
const OPENAI_MODEL = envValue("OPENAI_MODEL") || envValue("best_chatgpt_modal")
const OPENAI_USE_REASONING = boolEnv("OPENAI_USE_REASONING", true)
const OPENAI_TITLE_TIMEOUT_MS = numberEnv("OPENAI_TITLE_TIMEOUT_SECONDS", 240, 30, 900) * 1000
const OPENAI_RESEARCH_TIMEOUT_MS = numberEnv("OPENAI_RESEARCH_TIMEOUT_SECONDS", 60, 15, 300) * 1000
const OPENAI_MAX_RETRIES = numberEnv("OPENAI_MAX_RETRIES", 3, 1, 8)
const ENABLE_OPENAI_RESEARCH_AUDIT = boolEnv("ENABLE_OPENAI_RESEARCH_AUDIT", false)

const WEBFLOW_API_BASE = stringEnv("WEBFLOW_API_BASE", "https://api.webflow.com/v2").replace(/\/$/, "")
const WEBFLOW_TOKEN = envValue("WEBFLOW_API_TOKEN") || envValue("WEBFLOW_OAUTH_TOKEN")
const WEBFLOW_REQUEST_TIMEOUT_MS = numberEnv("WEBFLOW_REQUEST_TIMEOUT_SECONDS", 60, 10, 300) * 1000
const WEBFLOW_MAX_RETRIES = numberEnv("WEBFLOW_MAX_RETRIES", 4, 1, 10)

const DEFAULT_BANG_DOMAIN = "bangautoglass.com"
const DEFAULT_SERP_RESULT_LIMIT = 5
const DEFAULT_COMPETITOR_DOMAINS = [
  "safelite.com",
  "glassdoctor.com",
  "autoglassnow.com",
  "windshieldhub.com",
  "gerbercollision.com",
  "caliber.com",
]

const ALLOWED_SCRIPT_VARIABLES = ["Make", "Model", "City", "State", "Service Label"]
const ALLOWED_VARIABLE_ALIASES = {
  Make: ["Make", "make", "Vehicle Make", "vehicle_make", "vehicle make"],
  Model: ["Model", "model", "Vehicle Model", "vehicle_model", "vehicle model"],
  City: ["City", "city"],
  State: ["State", "state", "Province", "province"],
  "Service Label": [
    "Service Label",
    "service label",
    "service_label",
    "serviceLabel",
    "service-label",
    "Service",
    "service",
  ],
}

function envValue(name) {
  const value = process.env[name]
  return value && String(value).trim() ? String(value).trim() : ""
}

function mustGetEnv(name) {
  const value = envValue(name)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function stringEnv(name, fallback) {
  return envValue(name) || fallback
}

function numberEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name])
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function phaseNumberEnv(primaryName, legacyName, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (envValue(primaryName)) return numberEnv(primaryName, fallback, min, max)
  if (envValue(legacyName)) return numberEnv(legacyName, fallback, min, max)
  return numberEnv(primaryName, fallback, min, max)
}

function boolEnv(name, fallback) {
  const value = String(process.env[name] || "").toLowerCase().trim()
  if (["true", "1", "yes", "y"].includes(value)) return true
  if (["false", "0", "no", "n"].includes(value)) return false
  return fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asRecord(value, fallback = {}) {
  return isRecord(value) ? value : fallback
}

function stringifyValue(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function firstString(...values) {
  for (const value of values) {
    const text = stringifyValue(value).trim()
    if (text) return text
  }
  return ""
}

function compactObject(value) {
  const output = {}
  for (const [key, innerValue] of Object.entries(asRecord(value))) {
    if (innerValue === undefined || innerValue === null) continue
    if (typeof innerValue === "string" && innerValue.trim() === "") continue
    output[key] = innerValue
  }
  return output
}

function cleanPlainObject(value) {
  if (Array.isArray(value)) return value.map(cleanPlainObject)
  if (!isRecord(value)) return value
  const output = {}
  for (const [key, innerValue] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue
    output[key] = cleanPlainObject(innerValue)
  }
  return output
}

function safeErrorMessage(error, maxLength = 5000) {
  let raw = "Unknown error"

  if (error instanceof Error) {
    raw = error.message
  } else if (error && typeof error === "object") {
    try {
      raw = JSON.stringify(error)
    } catch {
      raw = Object.prototype.toString.call(error)
    }
  } else if (error !== undefined && error !== null) {
    raw = String(error)
  }

  return raw.length > maxLength ? `${raw.slice(0, maxLength)}... [truncated]` : raw
}

function normalizeReasoningEffort(value) {
  const effort = firstString(value).toLowerCase().replace(/[\s-]+/g, "_")
  if (["minimal", "low", "medium", "high"].includes(effort)) return effort
  if (["xhigh", "x_high", "extra_high", "very_high"].includes(effort)) return "high"
  return "high"
}

function normalizeResearchMode(value) {
  const mode = firstString(value).toLowerCase()
  if (["basic", "openai_web_search", "serp_provider", "serp_provider_plus_openai"].includes(mode)) return mode
  return "serp_provider_plus_openai"
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120)
}

function cleanBlogTitle(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s*[-*#`]+\s*/g, "")
    .replace(/^\s*\d+[\).:-]\s*/g, "")
    .replace(/^\s*(recommended\s+)?(seo\s+)?(blog\s+)?title\s*\d*\s*[:\-–—]\s*/i, "")
    .replace(/^\s*recommended\s+title\s*[:\-–—]\s*/i, "")
    .replace(/^\s*final\s+title\s*[:\-–—]\s*/i, "")
    .replace(/^\s*name\s*[:\-–—]\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeVariableKey(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

function canonicalScriptVariableName(value) {
  const normalized = normalizeVariableKey(value)
  if (!normalized) return ""

  for (const allowed of ALLOWED_SCRIPT_VARIABLES) {
    if (normalizeVariableKey(allowed) === normalized) return allowed
    for (const alias of ALLOWED_VARIABLE_ALIASES[allowed]) {
      if (normalizeVariableKey(alias) === normalized) return allowed
    }
  }

  return ""
}

function getValueCaseInsensitive(row, keys) {
  const record = asRecord(row)

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const value = stringifyValue(record[key]).trim()
      if (value) return value
    }
  }

  const lowerMap = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]))
  for (const key of keys) {
    const original = lowerMap.get(String(key).toLowerCase())
    if (!original) continue
    const value = stringifyValue(record[original]).trim()
    if (value) return value
  }

  return ""
}

function getVariableValue(variables, rawKey) {
  const canonical = canonicalScriptVariableName(rawKey)
  if (!canonical) return ""

  const record = asRecord(variables)
  if (Object.prototype.hasOwnProperty.call(record, canonical)) return stringifyValue(record[canonical])

  const lowerMap = new Map(Object.keys(record).map((candidate) => [normalizeVariableKey(candidate), candidate]))
  const direct = lowerMap.get(normalizeVariableKey(canonical))
  return direct ? stringifyValue(record[direct]) : ""
}

function buildVariablesFromAnyRow(row) {
  const record = asRecord(row)
  const sourceRow = asRecord(record.sourceRow || record.source_row || record.raw || record)
  const suppliedVariables = asRecord(record.variables || sourceRow.variables || sourceRow._variables)

  return compactObject({
    Make: firstString(record.make, suppliedVariables.Make, suppliedVariables.make, getValueCaseInsensitive(sourceRow, ALLOWED_VARIABLE_ALIASES.Make)),
    Model: firstString(record.model, suppliedVariables.Model, suppliedVariables.model, getValueCaseInsensitive(sourceRow, ALLOWED_VARIABLE_ALIASES.Model)),
    City: firstString(record.city, suppliedVariables.City, suppliedVariables.city, getValueCaseInsensitive(sourceRow, ALLOWED_VARIABLE_ALIASES.City)),
    State: firstString(record.state, suppliedVariables.State, suppliedVariables.state, getValueCaseInsensitive(sourceRow, ALLOWED_VARIABLE_ALIASES.State)),
    "Service Label": firstString(
      record.serviceLabel,
      record.service_label,
      suppliedVariables["Service Label"],
      suppliedVariables.serviceLabel,
      suppliedVariables.service_label,
      getValueCaseInsensitive(sourceRow, ALLOWED_VARIABLE_ALIASES["Service Label"])
    ),
  })
}

function assertSupportedScriptVariables(scriptTemplate) {
  const unsupported = []
  const regex = /\[([^\]]+)\]/g
  let match

  while ((match = regex.exec(scriptTemplate))) {
    const rawName = String(match[1] || "").trim()
    if (!rawName) continue
    if (!canonicalScriptVariableName(rawName) && !unsupported.includes(rawName)) unsupported.push(rawName)
  }

  if (unsupported.length) {
    throw new Error(
      `Unsupported script variable(s): ${unsupported.map((name) => `[${name}]`).join(", ")}. Only [Make], [Model], [City], [State], and [Service Label] are supported.`
    )
  }
}

function renderScriptTemplate(scriptTemplate, variables) {
  assertSupportedScriptVariables(scriptTemplate)
  return String(scriptTemplate || "").replace(/\[([^\]]+)\]/g, (_match, rawKey) => {
    const canonical = canonicalScriptVariableName(String(rawKey || ""))
    return canonical ? getVariableValue(variables, canonical) : ""
  })
}

function normalizeDomain(value) {
  const raw = stringifyValue(value).trim().toLowerCase()
  if (!raw) return ""

  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`)
    return url.hostname.replace(/^www\./, "")
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim()
  }
}

function domainMatches(candidate, target) {
  const candidateDomain = normalizeDomain(candidate)
  const targetDomain = normalizeDomain(target)
  if (!candidateDomain || !targetDomain) return false
  return candidateDomain === targetDomain || candidateDomain.endsWith(`.${targetDomain}`)
}

function normalizeDomainList(value, fallback) {
  const rawValues = Array.isArray(value)
    ? value.map(String)
    : firstString(value)
      ? firstString(value).split(/[\n,]+/)
      : fallback
  return Array.from(new Set(rawValues.map((item) => normalizeDomain(item)).filter(Boolean)))
}

function safeUrl(value) {
  const raw = stringifyValue(value).trim()
  if (!raw) return ""
  try {
    return new URL(raw).toString()
  } catch {
    return raw
  }
}

function buildQuery(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item))
    } else {
      search.set(key, String(value))
    }
  }
  const query = search.toString()
  return query ? `?${query}` : ""
}

function getActiveJobId(data) {
  return data?.jobId || data?.job?.jobId || data?.job?.id || null
}

function getStats(data) {
  const job = data?.job || {}
  const stats = job?.stats || data?.stats || {}
  const rowStats = stats.rows || stats.generation || {}
  const titleStats = stats.titles || stats.webflow || {}

  const totalRows = toNumber(stats.totalRows ?? job.totalSourceRows ?? job.total_source_rows, 0)
  const requestedTitleCount = toNumber(stats.requestedTitleCount ?? job.requestedTitleCount, 5)
  const expectedFinalTitles = toNumber(stats.expectedFinalTitles, totalRows * requestedTitleCount)
  const generatedTitleCount = toNumber(stats.generatedTitleCount ?? job.totalGeneratedTitles ?? job.total_generated_titles, 0)
  const titleCreated = toNumber(titleStats.created, 0)
  const webflowCreatedItemCount = toNumber(stats.webflowCreatedItemCount ?? job.totalCreatedItems ?? job.total_created_items, titleCreated)

  return {
    totalRows,
    requestedTitleCount,
    expectedFinalTitles,
    generatedTitleCount,
    errorCount: toNumber(stats.errorCount ?? job.errorCount ?? job.error_count, 0),
    rowPending: toNumber(rowStats.pending, 0),
    rowQueued: toNumber(rowStats.queued, 0),
    rowRunning: toNumber(rowStats.running, 0),
    rowSuccess: toNumber(rowStats.success, 0),
    rowError: toNumber(rowStats.error, 0),
    rowSkipped: toNumber(rowStats.skipped, 0),
    titleStaged: toNumber(titleStats.staged ?? titleStats.ready, 0),
    titleCreating: toNumber(titleStats.creating, 0),
    titleCreated,
    titleError: toNumber(titleStats.error, 0),
    titleSkipped: toNumber(titleStats.skipped, 0),
    titleDeleted: toNumber(titleStats.deleted, 0),
    webflowCreatedItemCount,
  }
}

function generationDone(stats) {
  return (
    stats.totalRows > 0 &&
    stats.rowSuccess === stats.totalRows &&
    stats.rowPending === 0 &&
    stats.rowQueued === 0 &&
    stats.rowRunning === 0 &&
    stats.generatedTitleCount >= stats.expectedFinalTitles
  )
}

function webflowDone(stats) {
  const targetTitleCount = stats.expectedFinalTitles || stats.generatedTitleCount
  return (
    targetTitleCount > 0 &&
    stats.titleCreated >= targetTitleCount &&
    stats.webflowCreatedItemCount >= targetTitleCount &&
    stats.titleStaged === 0 &&
    stats.titleCreating === 0
  )
}

function logJson(payload) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...payload }, null, 2))
}

function logProgress(label, data) {
  const stats = getStats(data)
  logJson({
    phase: PHASE,
    label,
    workerId: WORKER_ID,
    configuredJobId: JOB_ID || null,
    activeJobId: getActiveJobId(data),
    autoDiscoveryEnabled: !JOB_ID,
    message: data.message || null,
    claimedTotal: data.claimedTotal ?? null,
    processedCount: data.processedCount ?? null,
    staleResetCount: data.staleResetCount ?? null,
    totalRows: stats.totalRows,
    requestedTitleCount: stats.requestedTitleCount,
    generatedTitleCount: stats.generatedTitleCount,
    expectedFinalTitles: stats.expectedFinalTitles,
    errorCount: stats.errorCount,
    rows: {
      success: stats.rowSuccess,
      pending: stats.rowPending,
      queued: stats.rowQueued,
      running: stats.rowRunning,
      error: stats.rowError,
      skipped: stats.rowSkipped,
    },
    titles: {
      staged: stats.titleStaged,
      creating: stats.titleCreating,
      created: stats.titleCreated,
      createdItems: stats.webflowCreatedItemCount,
      error: stats.titleError,
      skipped: stats.titleSkipped,
      deleted: stats.titleDeleted,
    },
  })
  return stats
}

function buildEdgeRequestBody(action, extra = {}) {
  const body = {
    action,
    workerId: WORKER_ID,
    workerBatchSize: BATCH_SIZE,
    workerConcurrency: CONCURRENCY,
    generateBatchSize: GENERATE_BATCH_SIZE,
    generateConcurrency: GENERATE_CONCURRENCY,
    webflowBatchSize: WEBFLOW_BATCH_SIZE,
    webflowConcurrency: WEBFLOW_CONCURRENCY,
    resetStaleMinutes: RESET_STALE_MINUTES,
    includeRows: false,
    includeTitles: false,
    ...extra,
  }

  if (JOB_ID && !body.jobId) body.jobId = JOB_ID
  return body
}

async function fetchWithTimeout(url, init = {}, label = "request", timeoutMs = 30000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted || /abort|timeout|timed out/i.test(safeErrorMessage(error))) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function callJson(url, init = {}, options = {}) {
  const {
    label = "request",
    timeoutMs = 30000,
    retries = 1,
    retryStatuses = [408, 409, 425, 429, 500, 502, 503, 504],
  } = options

  let lastError = null

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, label, timeoutMs)
      const text = await response.text()
      let data = null

      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { raw: text.slice(0, 4000) }
      }

      if (!response.ok) {
        const shouldRetry = attempt < retries - 1 && retryStatuses.includes(response.status)
        if (shouldRetry) {
          const retryAfter = Number(response.headers.get("retry-after") || 0)
          const waitMs = retryAfter ? Math.min(retryAfter * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 15000)
          await sleep(waitMs)
          continue
        }
        throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(data).slice(0, 4000)}`)
      }

      return data
    } catch (error) {
      lastError = error
      if (attempt < retries - 1) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 15000))
        continue
      }
      throw lastError
    }
  }

  throw lastError || new Error(`${label} failed.`)
}

async function callEdge(action, extra = {}) {
  const body = buildEdgeRequestBody(action, extra)
  const data = await callJson(
    EDGE_FUNCTION_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-worker-secret": WORKER_SECRET,
      },
      body: JSON.stringify(cleanPlainObject(body)),
    },
    {
      label: `Edge Function ${action}`,
      timeoutMs: numberEnv("EDGE_REQUEST_TIMEOUT_SECONDS", 60, 10, 300) * 1000,
      retries: numberEnv("EDGE_MAX_RETRIES", 3, 1, 8),
    }
  )

  if (!data || data.success === false) {
    throw new Error(`Edge Function ${action} failed: ${JSON.stringify(data).slice(0, 4000)}`)
  }

  return data
}

function titleJsonSchema(titleCount) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      titles: {
        type: "array",
        minItems: titleCount,
        maxItems: titleCount,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            targetKeyword: { type: "string" },
            searchIntent: { type: "string" },
            angle: { type: "string" },
            rationale: { type: "string" },
            evidenceUsed: { type: "string" },
          },
          required: ["title", "targetKeyword", "searchIntent", "angle", "rationale", "evidenceUsed"],
        },
      },
    },
    required: ["titles"],
  }
}

function researchAuditSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      searchIntent: { type: "string" },
      competitorTitlePatterns: { type: "array", items: { type: "string" } },
      customerQuestions: { type: "array", items: { type: "string" } },
      recommendedAngles: { type: "array", items: { type: "string" } },
      avoidAngles: { type: "array", items: { type: "string" } },
      bestTitleStrategy: { type: "string" },
      evidenceSummary: { type: "string" },
    },
    required: [
      "searchIntent",
      "competitorTitlePatterns",
      "customerQuestions",
      "recommendedAngles",
      "avoidAngles",
      "bestTitleStrategy",
      "evidenceSummary",
    ],
  }
}

function getOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text.trim()

  const parts = []
  for (const item of response?.output || []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text)
      }
    }
  }
  return parts.join("\n").trim()
}

function parseJsonFromText(text, label) {
  if (!String(text || "").trim()) throw new Error(`${label} returned an empty response.`)

  try {
    return JSON.parse(text)
  } catch {
    const firstBrace = text.indexOf("{")
    const lastBrace = text.lastIndexOf("}")
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(`${label} was not valid JSON.`)
    }
    return JSON.parse(text.slice(firstBrace, lastBrace + 1))
  }
}

async function createOpenAIResponse(payload, label, timeoutMs) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY for generation phase.")
  if (!OPENAI_MODEL) throw new Error("Missing OPENAI_MODEL or best_chatgpt_modal for generation phase.")

  let requestPayload = { ...payload }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callJson(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify(requestPayload),
        },
        {
          label,
          timeoutMs,
          retries: OPENAI_MAX_RETRIES,
        }
      )
    } catch (error) {
      const message = safeErrorMessage(error)

      if (attempt === 0 && /reasoning/i.test(message) && requestPayload.reasoning) {
        const { reasoning, ...withoutReasoning } = requestPayload
        requestPayload = withoutReasoning
        logJson({ event: "openai_retry_without_reasoning", label, error: message.slice(0, 1000) })
        continue
      }

      throw error
    }
  }

  throw new Error(`${label} failed.`)
}

function toSerpResult(raw, fallbackPosition, source) {
  const record = asRecord(raw)
  const url = safeUrl(firstString(record.link, record.url, record.href, record.destination))
  const domain = normalizeDomain(firstString(record.domain, record.displayed_link, record.displayedLink, url))

  return {
    position: Number(record.position || record.rank || record.rank_group || record.pos || fallbackPosition || 0),
    title: cleanBlogTitle(firstString(record.title, record.name, record.headline)),
    url,
    domain,
    snippet: firstString(record.snippet, record.description, record.text),
    source,
    contentType: firstString(record.type, record.contentType),
  }
}

function normalizeSerpResults(values, source, limit) {
  const output = []
  const seen = new Set()

  for (let i = 0; i < values.length && output.length < limit; i++) {
    const result = toSerpResult(values[i], i + 1, source)
    const key = result.url || `${result.title}:${result.domain}`
    if (!result.title || !key || seen.has(key)) continue
    seen.add(key)
    output.push({ ...result, position: output.length + 1 })
  }

  return output
}

async function fetchSerpApiResults(query, limit) {
  const apiKey = envValue("SERPAPI_API_KEY")
  if (!apiKey) return null

  const params = new URLSearchParams({
    engine: stringEnv("SERPAPI_ENGINE", "google"),
    q: query,
    num: String(limit),
    api_key: apiKey,
  })

  const location = envValue("SERPAPI_LOCATION")
  if (location) params.set("location", location)

  const data = await callJson(`https://serpapi.com/search.json?${params.toString()}`, {}, {
    label: "SerpAPI request",
    timeoutMs: numberEnv("SERP_REQUEST_TIMEOUT_SECONDS", 15, 5, 90) * 1000,
    retries: numberEnv("SERP_MAX_RETRIES", 2, 1, 5),
  })

  const organic = Array.isArray(data?.organic_results) ? data.organic_results : []
  return normalizeSerpResults(organic, "serpapi", limit)
}

async function fetchDataForSeoResults(query, limit) {
  const login = envValue("DATAFORSEO_LOGIN")
  const password = envValue("DATAFORSEO_PASSWORD")
  if (!login || !password) return null

  const body = [
    {
      keyword: query,
      location_name: stringEnv("DATAFORSEO_LOCATION_NAME", "United States"),
      language_code: stringEnv("DATAFORSEO_LANGUAGE_CODE", "en"),
      depth: limit,
    },
  ]

  const data = await callJson("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, {
    label: "DataForSEO request",
    timeoutMs: numberEnv("SERP_REQUEST_TIMEOUT_SECONDS", 15, 5, 90) * 1000,
    retries: numberEnv("SERP_MAX_RETRIES", 2, 1, 5),
  })

  const items = data?.tasks?.[0]?.result?.[0]?.items
  const organic = Array.isArray(items) ? items.filter((item) => item.type === "organic") : []

  return normalizeSerpResults(
    organic.map((item) => ({
      position: item.rank_group || item.rank_absolute,
      title: item.title,
      url: item.url,
      domain: item.domain,
      snippet: item.description,
      type: item.type,
    })),
    "dataforseo",
    limit
  )
}

async function fetchBingResults(query, limit) {
  const apiKey = envValue("BING_SEARCH_API_KEY")
  if (!apiKey) return null

  const endpoint = stringEnv("BING_SEARCH_ENDPOINT", "https://api.bing.microsoft.com/v7.0/search")
  const params = new URLSearchParams({
    q: query,
    count: String(limit),
    responseFilter: "Webpages",
  })

  const data = await callJson(`${endpoint}?${params.toString()}`, {
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
    },
  }, {
    label: "Bing Search request",
    timeoutMs: numberEnv("SERP_REQUEST_TIMEOUT_SECONDS", 15, 5, 90) * 1000,
    retries: numberEnv("SERP_MAX_RETRIES", 2, 1, 5),
  })

  const webPages = Array.isArray(data?.webPages?.value) ? data.webPages.value : []
  return normalizeSerpResults(
    webPages.map((item, index) => ({
      position: index + 1,
      title: item.name,
      url: item.url,
      snippet: item.snippet,
    })),
    "bing",
    limit
  )
}

async function fetchConfiguredSerpResults(query, limit) {
  const preferred = stringEnv("TITLE_RESEARCH_SERP_PROVIDER", "auto").toLowerCase()
  const providers = preferred === "auto" ? ["serpapi", "dataforseo", "bing"] : [preferred]

  for (const provider of providers) {
    try {
      if (provider === "serpapi") {
        const results = await fetchSerpApiResults(query, limit)
        if (results) return { provider: "serpapi", results }
      }
      if (provider === "dataforseo") {
        const results = await fetchDataForSeoResults(query, limit)
        if (results) return { provider: "dataforseo", results }
      }
      if (provider === "bing") {
        const results = await fetchBingResults(query, limit)
        if (results) return { provider: "bing", results }
      }
    } catch (error) {
      logJson({ event: "serp_provider_error", provider, query, error: safeErrorMessage(error, 1500) })
    }
  }

  return { provider: "none", results: [] }
}

function getTitlePattern(title) {
  const clean = cleanBlogTitle(title)
  if (!clean) return ""
  if (/\b(cost|price|pricing|insurance|deductible)\b/i.test(clean)) return "Cost, insurance, or value concern"
  if (/\b(repair|replace|replacement|fix)\b/i.test(clean)) return "Repair versus replacement decision"
  if (/\b(adas|calibration|camera|sensor|lane|rain)\b/i.test(clean)) return "Vehicle technology, sensors, or calibration"
  if (/\b(chip|crack|cracked|damage|shattered|leak)\b/i.test(clean)) return "Damage symptoms and urgency"
  if (/\b(mobile|same[-\s]?day|near me|local)\b/i.test(clean)) return "Local/mobile service convenience"
  if (/\b(guide|what to know|how to|when to|why)\b/i.test(clean)) return "Educational guide or decision support"
  return "General auto glass service intent"
}

function uniqueNonEmpty(values, limit = 10) {
  const seen = new Set()
  const output = []
  for (const value of values) {
    const clean = String(value || "").replace(/\s+/g, " ").trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    output.push(clean)
    if (output.length >= limit) break
  }
  return output
}

function buildSerpQuery({ variables, renderedPrompt }) {
  const make = firstString(getVariableValue(variables, "Make"))
  const model = firstString(getVariableValue(variables, "Model"))
  const city = firstString(getVariableValue(variables, "City"))
  const state = firstString(getVariableValue(variables, "State"))
  const serviceLabel = firstString(getVariableValue(variables, "Service Label"))

  const vehicle = [make, model].filter(Boolean).join(" ").trim()
  const location = [city, state].filter(Boolean).join(" ").trim()

  const candidates = [
    [vehicle, serviceLabel, location].filter(Boolean).join(" "),
    [serviceLabel, location].filter(Boolean).join(" "),
    [vehicle, serviceLabel].filter(Boolean).join(" "),
    String(renderedPrompt || "").replace(/\s+/g, " ").replace(/[^\w\s,-]/g, "").trim().slice(0, 160),
  ].map((item) => item.trim()).filter(Boolean)

  return candidates[0] || "auto glass blog title ideas"
}

function buildLightweightSerpAudit({ researchMode, searchedAt, serpQuery, serpProvider, bangDomain, competitorDomains, providerResults, variables }) {
  const topResults = providerResults.slice(0, DEFAULT_SERP_RESULT_LIMIT)
  const competitorResults = topResults.filter((result) => competitorDomains.some((domain) => domainMatches(result.domain || result.url, domain)))
  const bangAutoglassResults = topResults.filter((result) => domainMatches(result.domain || result.url, bangDomain))

  const city = firstString(getVariableValue(variables, "City"))
  const state = firstString(getVariableValue(variables, "State"))
  const make = firstString(getVariableValue(variables, "Make"))
  const model = firstString(getVariableValue(variables, "Model"))
  const serviceLabel = firstString(getVariableValue(variables, "Service Label"))
  const vehicle = [make, model].filter(Boolean).join(" ").trim()
  const location = [city, state].filter(Boolean).join(", ").trim()

  const resultText = topResults.map((result) => `${result.title} ${result.snippet}`).join(" ")

  const searchIntent = /\b(cost|price|pricing|insurance|deductible)\b/i.test(resultText)
    ? "Customer is likely comparing cost, insurance, and value before choosing auto glass service."
    : /\b(repair|replace|replacement|chip|crack)\b/i.test(resultText)
      ? "Customer is likely deciding whether damaged auto glass needs repair or replacement."
      : /\b(adas|calibration|camera|sensor|lane|rain)\b/i.test(resultText)
        ? "Customer is likely researching safety technology or calibration implications before service."
        : "Customer is likely looking for useful auto glass guidance with local service relevance."

  return {
    researchMode,
    searchedAt,
    serpQuery,
    serpProvider,
    bangDomain,
    competitorDomains,
    topResults,
    competitorResults,
    bangAutoglassResults,
    searchIntent,
    competitorTitlePatterns: uniqueNonEmpty(topResults.map((result) => getTitlePattern(result.title)), 6),
    customerQuestions: uniqueNonEmpty([
      serviceLabel && location ? `What should drivers know about ${serviceLabel} in ${location}?` : "What should drivers know before booking auto glass service?",
      serviceLabel ? `When does ${serviceLabel} become urgent?` : "When does auto glass damage become urgent?",
      vehicle && serviceLabel ? `Does a ${vehicle} need special handling for ${serviceLabel}?` : "Does the vehicle need special handling, sensors, or calibration?",
      "Should the customer repair the damage or replace the glass?",
      "What should the customer ask before scheduling service?",
    ], 5),
    recommendedAngles: uniqueNonEmpty([
      serviceLabel && location ? `${serviceLabel} decision guide for ${location} drivers` : "Practical auto glass decision guide",
      "Repair versus replacement guidance",
      "Cost, insurance, and value concerns without unsupported exact-price claims",
      "Safety, visibility, ADAS, sensor, or calibration implications",
      vehicle ? `${vehicle}-specific owner concerns` : "Vehicle-specific owner concerns",
    ], 6),
    avoidAngles: [
      "Do not copy competitor titles or SERP wording exactly.",
      "Do not invent exact prices, warranties, guarantees, legal rules, or insurance outcomes.",
      "Avoid generic best/top list titles unless the SERP clearly supports list intent.",
      "Avoid keyword-stuffed city pages disguised as blog posts.",
    ],
    bestTitleStrategy: [
      "Use the SERP snapshot to choose distinct, customer-acquisition title angles.",
      "Prioritize practical decision support over broad informational traffic.",
      location ? `Use ${location} only when it makes the title more specific and natural.` : "Use local context only when it makes the title more specific and natural.",
      vehicle ? `Use ${vehicle} where it creates clear owner relevance.` : "Use make/model context where it creates clear owner relevance.",
    ].join(" "),
    evidenceSummary: topResults.length
      ? `SERP audit used ${topResults.length} ${serpProvider} result(s) for query "${serpQuery}".`
      : `No SERP provider results were available for query "${serpQuery}". Titles should rely on the rendered script, row variables, and conservative SEO best practices.`,
  }
}

async function maybeEnhanceAuditWithOpenAI({ audit, renderedPrompt, variables, reasoningEffort }) {
  if (!ENABLE_OPENAI_RESEARCH_AUDIT) return audit

  const prompt = [
    "You are an SEO SERP research auditor for Bang AutoGlass blog-title generation.",
    "Use the provided SERP results and row variables. Do not browse the web. Do not invent rankings.",
    "Return valid JSON only.",
    "",
    "Rendered script:",
    renderedPrompt,
    "",
    "Variables:",
    JSON.stringify(variables, null, 2),
    "",
    "Existing SERP audit:",
    JSON.stringify(audit, null, 2),
  ].join("\n")

  const payload = {
    model: OPENAI_MODEL,
    instructions: "Return only valid JSON matching the supplied schema. Do not copy competitor titles. Do not invent SERP rankings.",
    input: prompt,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "webflow_blog_title_research_audit",
        strict: true,
        schema: researchAuditSchema(),
      },
    },
  }

  if (OPENAI_USE_REASONING) payload.reasoning = { effort: reasoningEffort }

  try {
    const response = await createOpenAIResponse(payload, "OpenAI research audit", OPENAI_RESEARCH_TIMEOUT_MS)
    const parsed = asRecord(parseJsonFromText(getOutputText(response), "OpenAI research audit"))
    return {
      ...audit,
      searchIntent: firstString(parsed.searchIntent, audit.searchIntent),
      competitorTitlePatterns: Array.isArray(parsed.competitorTitlePatterns) ? parsed.competitorTitlePatterns.map(String).filter(Boolean) : audit.competitorTitlePatterns,
      customerQuestions: Array.isArray(parsed.customerQuestions) ? parsed.customerQuestions.map(String).filter(Boolean) : audit.customerQuestions,
      recommendedAngles: Array.isArray(parsed.recommendedAngles) ? parsed.recommendedAngles.map(String).filter(Boolean) : audit.recommendedAngles,
      avoidAngles: Array.isArray(parsed.avoidAngles) ? parsed.avoidAngles.map(String).filter(Boolean) : audit.avoidAngles,
      bestTitleStrategy: firstString(parsed.bestTitleStrategy, audit.bestTitleStrategy),
      evidenceSummary: firstString(parsed.evidenceSummary, audit.evidenceSummary),
    }
  } catch (error) {
    return {
      ...audit,
      evidenceSummary: `${audit.evidenceSummary} OpenAI audit enhancement was skipped because it failed or timed out: ${safeErrorMessage(error, 800)}`,
    }
  }
}

async function buildResearchAuditForRow({ job, row, renderedPrompt, variables }) {
  const researchMode = normalizeResearchMode(job?.researchMode || job?.config?.researchMode || job?.config?.research_mode || row?.researchMode)
  const serpResultLimit = toNumber(job?.serpResultLimit || job?.config?.serpResultLimit || job?.config?.serp_result_limit, DEFAULT_SERP_RESULT_LIMIT)
  const bangDomain = normalizeDomain(firstString(job?.bangDomain, job?.config?.bangDomain, job?.config?.bang_domain, DEFAULT_BANG_DOMAIN))
  const competitorDomains = normalizeDomainList(job?.competitorDomains || job?.config?.competitorDomains || job?.config?.competitor_domains, DEFAULT_COMPETITOR_DOMAINS)
  const serpQuery = firstString(job?.config?.serpQuery, job?.config?.serp_query, buildSerpQuery({ variables, renderedPrompt }))
  const searchedAt = new Date().toISOString()

  if (researchMode === "basic") {
    return {
      researchMode,
      serpQuery,
      serpProvider: "none",
      serpResults: [],
      audit: {
        researchMode,
        searchedAt,
        serpQuery,
        serpProvider: "none",
        bangDomain,
        competitorDomains,
        topResults: [],
        competitorResults: [],
        bangAutoglassResults: [],
        searchIntent: "",
        competitorTitlePatterns: [],
        customerQuestions: [],
        recommendedAngles: [],
        avoidAngles: [],
        bestTitleStrategy: "",
        evidenceSummary: "Research mode was basic, so no SERP audit was performed.",
      },
    }
  }

  const configured = researchMode === "serp_provider" || researchMode === "serp_provider_plus_openai"
    ? await fetchConfiguredSerpResults(serpQuery, Math.max(1, Math.min(20, serpResultLimit)))
    : { provider: "none", results: [] }

  let audit = buildLightweightSerpAudit({
    researchMode,
    searchedAt,
    serpQuery,
    serpProvider: configured.provider,
    bangDomain,
    competitorDomains,
    providerResults: configured.results,
    variables,
  })

  audit = await maybeEnhanceAuditWithOpenAI({
    audit,
    renderedPrompt,
    variables,
    reasoningEffort: normalizeReasoningEffort(job?.reasoningEffort || job?.reasoning_effort),
  })

  return {
    researchMode,
    serpQuery,
    serpProvider: audit.serpProvider,
    serpResults: audit.topResults,
    audit,
  }
}

function formatResearchForTitlePrompt(audit) {
  return [
    "SERP research audit:",
    JSON.stringify(audit, null, 2),
    "",
    "Title generation rules from the research:",
    "- Use the audit as evidence for intent and angle selection.",
    "- Do not copy competitor titles.",
    "- Titles must be specific, customer-acquisition focused, and useful.",
    "- Prefer high-intent title angles where supported by the user script and evidence.",
    "- Avoid exact claims about prices, legal rules, warranties, guaranteed timelines, or insurance coverage unless explicitly supplied.",
  ].join("\n")
}

function parseGeneratedTitles(response, titleCount) {
  const outputText = getOutputText(response)
  const parsed = parseJsonFromText(outputText, "OpenAI blog title generation")
  const rawTitles = Array.isArray(parsed?.titles) ? parsed.titles : []
  const titles = []
  const seen = new Set()

  for (const raw of rawTitles) {
    const record = asRecord(raw)
    const title = cleanBlogTitle(firstString(record.title, raw))
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    titles.push({
      titleIndex: titles.length,
      title,
      slug: slugify(title),
      targetKeyword: firstString(record.targetKeyword, record.target_keyword),
      searchIntent: firstString(record.searchIntent, record.search_intent),
      angle: firstString(record.angle),
      rationale: firstString(record.rationale),
      evidenceUsed: firstString(record.evidenceUsed, record.evidence_used),
    })
  }

  if (titles.length !== titleCount) {
    throw new Error(`OpenAI returned ${titles.length} clean unique title(s), but exactly ${titleCount} were required.`)
  }

  return { outputText, parsed, titles }
}

async function generateTitlesForRow(job, row) {
  const variables = buildVariablesFromAnyRow(row)
  const scriptTemplate = firstString(job?.scriptTemplate, job?.instructions, job?.config?.scriptTemplate, job?.config?.instructions)
  if (!scriptTemplate) throw new Error("This job is missing scriptTemplate/instructions.")

  const renderedPrompt = renderScriptTemplate(scriptTemplate, variables)
  const requestedTitleCount = toNumber(job?.requestedTitleCount || job?.config?.requestedTitleCount || job?.config?.requested_title_count, 5)
  const reasoningEffort = normalizeReasoningEffort(job?.reasoningEffort || job?.reasoning_effort || job?.config?.reasoningEffort)

  const research = await buildResearchAuditForRow({ job, row, renderedPrompt, variables })

  const systemInstructions = [
    "You are Bang AutoGlass SEO Blog Title Strategist.",
    `Your task is to generate exactly ${requestedTitleCount} elite, publishable Webflow CMS blog post titles.`,
    "Follow the user's rendered script exactly.",
    "Use the supplied variables as factual context.",
    "Use the SERP research audit to understand intent, competitive patterns, customer questions, and title opportunities.",
    "If the audit is lightweight or has limited SERP evidence, rely more heavily on the rendered script and row variables.",
    "Do not copy competitor titles.",
    "Do not generate body copy, meta descriptions, outlines, markdown, bullets, numbering, or commentary.",
    "Do not invent exact prices, laws, guarantees, warranties, certifications, insurance affiliations, or service availability unless explicitly supplied.",
    "Return only valid JSON matching the schema.",
  ].join("\n")

  const input = [
    "Rendered script:",
    renderedPrompt,
    "",
    "Variables:",
    JSON.stringify(variables, null, 2),
    "",
    formatResearchForTitlePrompt(research.audit),
    "",
    `Output exactly ${requestedTitleCount} blog titles.`,
  ].join("\n")

  const payload = {
    model: OPENAI_MODEL,
    instructions: systemInstructions,
    input,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "webflow_blog_title_creation",
        strict: true,
        schema: titleJsonSchema(requestedTitleCount),
      },
    },
  }

  if (OPENAI_USE_REASONING) payload.reasoning = { effort: reasoningEffort }

  const response = await createOpenAIResponse(payload, "OpenAI blog title generation", OPENAI_TITLE_TIMEOUT_MS)
  const parsed = parseGeneratedTitles(response, requestedTitleCount)

  return {
    renderedPrompt,
    research,
    openaiResponseId: String(response?.id || ""),
    openaiRawResponse: {
      id: response?.id || null,
      model: OPENAI_MODEL,
      reasoningEffort,
      outputText: parsed.outputText,
      parsed: parsed.parsed,
    },
    titles: parsed.titles,
  }
}

async function processGenerationRow(claimData, row) {
  const rowId = String(row.id || "")
  const rowIndex = row.rowIndex ?? row.row_index
  const job = claimData.job || {}
  const startedAt = Date.now()

  logJson({
    event: "generation_row_started",
    phase: "generate",
    workerId: WORKER_ID,
    jobId: claimData.jobId || job.jobId || job.id || null,
    rowId,
    rowIndex,
  })

  try {
    const generated = await generateTitlesForRow(job, row)

    await callEdge("complete_generation_row", {
      jobId: claimData.jobId || job.jobId || job.id,
      rowId,
      generatedTitles: generated.titles,
      generatedPayload: {
        renderedPrompt: generated.renderedPrompt,
        research: generated.research,
        openaiResponseId: generated.openaiResponseId,
        openaiRawResponse: generated.openaiRawResponse,
        titles: generated.titles,
      },
      message: `Generated ${generated.titles.length} title(s) by Render worker.`,
    })

    logJson({
      event: "generation_row_completed",
      phase: "generate",
      workerId: WORKER_ID,
      jobId: claimData.jobId || job.jobId || job.id || null,
      rowId,
      rowIndex,
      durationMs: Date.now() - startedAt,
      generatedTitleCount: generated.titles.length,
      serpProvider: generated.research?.serpProvider,
      researchMode: generated.research?.researchMode,
    })

    return {
      rowId,
      rowIndex,
      success: true,
      generatedTitleCount: generated.titles.length,
      serpProvider: generated.research?.serpProvider,
      researchMode: generated.research?.researchMode,
    }
  } catch (error) {
    const message = safeErrorMessage(error)
    await callEdge("fail_generation_row", {
      jobId: claimData.jobId || job.jobId || job.id,
      rowId,
      error: message,
    })
    logJson({
      event: "generation_row_failed",
      phase: "generate",
      workerId: WORKER_ID,
      jobId: claimData.jobId || job.jobId || job.id || null,
      rowId,
      rowIndex,
      durationMs: Date.now() - startedAt,
      error: message,
    })

    return {
      rowId,
      rowIndex,
      success: false,
      error: message,
    }
  }
}

function getWebflowItemId(data) {
  return (
    data?.data?.id ||
    data?.data?._id ||
    data?.id ||
    data?._id ||
    data?.result?.data?.id ||
    data?.result?.data?._id ||
    data?.result?.id ||
    data?.result?._id ||
    data?.items?.[0]?.id ||
    data?.items?.[0]?._id ||
    data?.data?.items?.[0]?.id ||
    data?.data?.items?.[0]?._id ||
    ""
  )
}

function validateWebflowId(value, name) {
  const clean = String(value || "").trim()
  if (!clean) throw new Error(`Missing required Webflow parameter: ${name}.`)
  if (clean.length > 160 || !/^[a-zA-Z0-9_-]+$/.test(clean)) {
    throw new Error(`${name} is invalid. Expected only letters, numbers, underscores, or hyphens.`)
  }
  return clean
}

async function webflowRequest({ method, path, body, query = {} }) {
  if (!WEBFLOW_TOKEN) throw new Error("Missing WEBFLOW_API_TOKEN or WEBFLOW_OAUTH_TOKEN for webflow phase.")

  const endpoint = `${WEBFLOW_API_BASE}${path}${buildQuery(query)}`
  const headers = {
    Authorization: `Bearer ${WEBFLOW_TOKEN}`,
    Accept: "application/json",
  }

  const init = { method, headers }
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(cleanPlainObject(body))
  }

  return await callJson(endpoint, init, {
    label: `Webflow ${method} ${path}`,
    timeoutMs: WEBFLOW_REQUEST_TIMEOUT_MS,
    retries: WEBFLOW_MAX_RETRIES,
  })
}

async function createWebflowItemForClaim(job, title) {
  const collectionId = validateWebflowId(
    firstString(job?.webflowCollectionId, job?.collection_id, job?.collectionId, job?.config?.webflowCollectionId, job?.config?.collectionId),
    "webflowCollectionId"
  )

  const publishMode = firstString(job?.webflowPublishMode, job?.publish_mode, job?.publishMode, "live")
  const localeId = firstString(job?.webflowLocaleId, job?.config?.webflowLocaleId, job?.config?.localeId)
  const fieldData = compactObject(title.fieldData || title.field_data || {})

  if (!firstString(fieldData.name, title.title, title.cleanTitle, title.rawTitle)) {
    throw new Error("Cannot create Webflow item because fieldData.name is empty.")
  }

  const itemBody = {
    fieldData,
    isArchived: false,
    isDraft: publishMode !== "live",
  }

  if (localeId) itemBody.cmsLocaleId = localeId

  const path = publishMode === "live"
    ? `/collections/${collectionId}/items/live`
    : `/collections/${collectionId}/items`

  const response = await webflowRequest({
    method: "POST",
    path,
    query: { skipInvalidFiles: true },
    body: itemBody,
  })

  return {
    webflowItemId: getWebflowItemId(response),
    fieldData,
    response,
    endpointPath: path,
  }
}

async function processWebflowTitle(claimData, title) {
  const titleId = String(title.id || "")
  const job = claimData.job || {}

  try {
    const created = await createWebflowItemForClaim(job, title)

    await callEdge("complete_webflow_title", {
      jobId: claimData.jobId || job.jobId || job.id,
      titleId,
      webflowItemId: created.webflowItemId,
      fieldData: created.fieldData,
      webflowResponse: {
        endpointPath: created.endpointPath,
        response: created.response,
      },
      message: "Created in Webflow by Render worker.",
    })

    return {
      titleId,
      rowId: title.rowId,
      rowIndex: title.rowIndex,
      titleIndex: title.titleIndex,
      success: true,
      webflowItemId: created.webflowItemId,
    }
  } catch (error) {
    const message = safeErrorMessage(error)
    await callEdge("fail_webflow_title", {
      jobId: claimData.jobId || job.jobId || job.id,
      titleId,
      error: message,
    })
    return {
      titleId,
      rowId: title.rowId,
      rowIndex: title.rowIndex,
      titleIndex: title.titleIndex,
      success: false,
      error: message,
    }
  }
}

async function processWithConcurrency(items, concurrency, worker) {
  const results = []
  let nextIndex = 0

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++
      results[currentIndex] = await worker(items[currentIndex])
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()))
  return results
}

async function getQueueStatus(phase, jobId = "") {
  return await callEdge("get_queue_status", {
    phase,
    jobId: jobId || JOB_ID || undefined,
    includeRows: false,
    includeTitles: false,
  })
}

async function runGenerateLoopOnce() {
  const claimData = await callEdge("claim_generation_rows", {
    workerBatchSize: GENERATE_BATCH_SIZE,
    workerConcurrency: GENERATE_CONCURRENCY,
    resetStaleMinutes: RESET_STALE_MINUTES,
  })

  logProgress("generation_claim_complete", claimData)

  if (!getActiveJobId(claimData) && Number(claimData.claimedTotal || 0) === 0) {
    return { worked: false, done: false, data: claimData }
  }

  if (!Array.isArray(claimData.rows) || !claimData.rows.length) {
    const status = await getQueueStatus("generate", claimData.jobId)
    const stats = logProgress("generation_no_rows_claimed", status)
    return { worked: false, done: generationDone(stats), data: status }
  }

  const activeConcurrency = Math.min(GENERATE_CONCURRENCY, claimData.rows.length)

  logJson({
    event: "generation_batch_processing_started",
    phase: "generate",
    workerId: WORKER_ID,
    jobId: claimData.jobId,
    claimedRows: claimData.rows.length,
    configuredBatchSize: GENERATE_BATCH_SIZE,
    configuredConcurrency: GENERATE_CONCURRENCY,
    activeConcurrency,
  })

  const results = await processWithConcurrency(claimData.rows, GENERATE_CONCURRENCY, (row) => processGenerationRow(claimData, row))

  logJson({
    event: "generation_rows_processed",
    phase: "generate",
    workerId: WORKER_ID,
    jobId: claimData.jobId,
    configuredBatchSize: GENERATE_BATCH_SIZE,
    configuredConcurrency: GENERATE_CONCURRENCY,
    activeConcurrency,
    processedCount: results.length,
    successCount: results.filter((result) => result?.success).length,
    errorCount: results.filter((result) => !result?.success).length,
    results,
  })

  const status = await getQueueStatus("generate", claimData.jobId)
  const stats = logProgress("generation_status_after_processing", status)

  if (STOP_ON_ERRORS && stats.rowError > 0) {
    throw new Error("Generation errors found and STOP_ON_ERRORS=true.")
  }

  return { worked: results.length > 0, done: generationDone(stats), data: status }
}

async function runWebflowLoopOnce() {
  const claimData = await callEdge("claim_webflow_titles", {
    workerBatchSize: WEBFLOW_BATCH_SIZE,
    workerConcurrency: WEBFLOW_CONCURRENCY,
    resetStaleMinutes: RESET_STALE_MINUTES,
  })

  logProgress("webflow_claim_complete", claimData)

  if (!getActiveJobId(claimData) && Number(claimData.claimedTotal || 0) === 0) {
    return { worked: false, done: false, data: claimData }
  }

  if (!Array.isArray(claimData.titles) || !claimData.titles.length) {
    const status = await getQueueStatus("webflow", claimData.jobId)
    const stats = logProgress("webflow_no_titles_claimed", status)
    return { worked: false, done: webflowDone(stats), data: status }
  }

  const activeConcurrency = Math.min(WEBFLOW_CONCURRENCY, claimData.titles.length)

  logJson({
    event: "webflow_batch_processing_started",
    phase: "webflow",
    workerId: WORKER_ID,
    jobId: claimData.jobId,
    claimedTitles: claimData.titles.length,
    configuredBatchSize: WEBFLOW_BATCH_SIZE,
    configuredConcurrency: WEBFLOW_CONCURRENCY,
    activeConcurrency,
  })

  const results = await processWithConcurrency(claimData.titles, WEBFLOW_CONCURRENCY, (title) => processWebflowTitle(claimData, title))

  logJson({
    event: "webflow_titles_processed",
    phase: "webflow",
    workerId: WORKER_ID,
    jobId: claimData.jobId,
    configuredBatchSize: WEBFLOW_BATCH_SIZE,
    configuredConcurrency: WEBFLOW_CONCURRENCY,
    activeConcurrency,
    processedCount: results.length,
    successCount: results.filter((result) => result?.success).length,
    errorCount: results.filter((result) => !result?.success).length,
    results,
  })

  const status = await getQueueStatus("webflow", claimData.jobId)
  const stats = logProgress("webflow_status_after_processing", status)

  if (STOP_ON_ERRORS && stats.titleError > 0) {
    throw new Error("Webflow title errors found and STOP_ON_ERRORS=true.")
  }

  return { worked: results.length > 0, done: webflowDone(stats), data: status }
}

function validatePhaseAndEnv() {
  if (!["generate", "webflow", "all"].includes(PHASE)) {
    throw new Error(`Invalid PHASE: ${PHASE}. Use "generate", "webflow", or "all".`)
  }

  if ((PHASE === "generate" || PHASE === "all") && (!OPENAI_API_KEY || !OPENAI_MODEL)) {
    throw new Error("PHASE=generate/all requires OPENAI_API_KEY and OPENAI_MODEL or best_chatgpt_modal.")
  }

  if ((PHASE === "webflow" || PHASE === "all") && !WEBFLOW_TOKEN) {
    throw new Error("PHASE=webflow/all requires WEBFLOW_API_TOKEN or WEBFLOW_OAUTH_TOKEN.")
  }
}

async function main() {
  validatePhaseAndEnv()

  logJson({
    event: "worker_starting",
    phase: PHASE,
    workerId: WORKER_ID,
    configuredJobId: JOB_ID || null,
    autoDiscoveryEnabled: !JOB_ID,
    activeBatchSizeForCurrentPhase: BATCH_SIZE,
    activeConcurrencyForCurrentPhase: CONCURRENCY,
    generateBatchSize: GENERATE_BATCH_SIZE,
    generateConcurrency: GENERATE_CONCURRENCY,
    webflowBatchSize: WEBFLOW_BATCH_SIZE,
    webflowConcurrency: WEBFLOW_CONCURRENCY,
    maxGenerateBatchSize: MAX_GENERATE_BATCH_SIZE,
    maxGenerateConcurrency: MAX_GENERATE_CONCURRENCY,
    maxWebflowBatchSize: MAX_WEBFLOW_BATCH_SIZE,
    maxWebflowConcurrency: MAX_WEBFLOW_CONCURRENCY,
    resetStaleMinutes: RESET_STALE_MINUTES,
    stopOnErrors: STOP_ON_ERRORS,
    keepAliveWhenDone: KEEP_ALIVE_WHEN_DONE,
    openaiModel: PHASE === "generate" || PHASE === "all" ? OPENAI_MODEL : null,
    openaiTitleTimeoutSeconds: Math.round(OPENAI_TITLE_TIMEOUT_MS / 1000),
    openaiResearchAuditEnabled: ENABLE_OPENAI_RESEARCH_AUDIT,
    webflowApiBase: PHASE === "webflow" || PHASE === "all" ? WEBFLOW_API_BASE : null,
    queueActions: {
      generate: ["claim_generation_rows", "complete_generation_row", "fail_generation_row"],
      webflow: ["claim_webflow_titles", "complete_webflow_title", "fail_webflow_title"],
    },
  })

  while (true) {
    try {
      let result = null

      if (PHASE === "generate") {
        result = await runGenerateLoopOnce()
      } else if (PHASE === "webflow") {
        result = await runWebflowLoopOnce()
      } else {
        const generationResult = await runGenerateLoopOnce()
        if (generationResult.worked) {
          result = generationResult
        } else {
          result = await runWebflowLoopOnce()
        }
      }

      if (result?.done) {
        logJson({ event: "active_job_done", phase: PHASE, workerId: WORKER_ID, configuredJobId: JOB_ID || null })
        if (!KEEP_ALIVE_WHEN_DONE) process.exit(0)
        await sleep(IDLE_SLEEP_MS)
        continue
      }

      await sleep(result?.worked ? SLEEP_MS : IDLE_SLEEP_MS)
    } catch (error) {
      logJson({
        event: "worker_error",
        phase: PHASE,
        workerId: WORKER_ID,
        configuredJobId: JOB_ID || null,
        autoDiscoveryEnabled: !JOB_ID,
        error: safeErrorMessage(error),
      })

      await sleep(ERROR_SLEEP_MS)
    }
  }
}

main().catch((error) => {
  logJson({ event: "fatal_worker_error", error: safeErrorMessage(error) })
  process.exit(1)
})
