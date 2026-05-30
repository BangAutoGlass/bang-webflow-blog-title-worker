const EDGE_FUNCTION_URL = mustGetEnv("EDGE_FUNCTION_URL")
const WORKER_SECRET = mustGetEnv("WORKER_SECRET")

// JOB_ID is optional.
// If blank/missing, the Supabase Edge Function auto-discovers the next eligible job.
const JOB_ID = process.env.JOB_ID || ""

const PHASE = process.env.PHASE || "generate"
// PHASE options:
// generate = generate titles from public.webflow_blog_title_creation_generation_rows
// webflow = create Webflow CMS items from public.webflow_blog_title_creation_generation_titles

const WORKER_ID = process.env.WORKER_ID || `render-${PHASE}-worker`

const BATCH_SIZE = numberEnv("BATCH_SIZE", PHASE === "webflow" ? 5 : 1)
const CONCURRENCY = numberEnv("CONCURRENCY", 1)
const MAX_WORKER_SECONDS = numberEnv("MAX_WORKER_SECONDS", 90)
const RESET_STALE_MINUTES = numberEnv("RESET_STALE_MINUTES", 45)

const SLEEP_MS = numberEnv("SLEEP_MS", 5000)
const IDLE_SLEEP_MS = numberEnv("IDLE_SLEEP_MS", 60000)
const ERROR_SLEEP_MS = numberEnv("ERROR_SLEEP_MS", 30000)

const STOP_ON_ERRORS = boolEnv("STOP_ON_ERRORS", true)
const KEEP_ALIVE_WHEN_DONE = boolEnv("KEEP_ALIVE_WHEN_DONE", true)

function mustGetEnv(name) {
  const value = process.env[name]

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value.trim()
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
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

function getActiveJobId(data) {
  return data?.jobId || data?.job?.jobId || data?.job?.id || null
}

function getStats(data) {
  const job = data?.job || {}
  const stats = job?.stats || data?.stats || {}

  // New normalized edge function shape:
  // stats.rows = generation row statuses from public.webflow_blog_title_creation_generation_rows
  // stats.titles = generated title/Webflow item statuses from public.webflow_blog_title_creation_generation_titles
  //
  // Backward compatibility:
  // Older versions used stats.generation and stats.webflow.
  const rowStats = stats.rows || stats.generation || {}
  const titleStats = stats.titles || stats.webflow || {}

  const totalRows = toNumber(
    stats.totalRows ?? job.totalSourceRows ?? job.total_source_rows,
    0
  )

  const requestedTitleCount = toNumber(
    stats.requestedTitleCount ?? job.requestedTitleCount,
    5
  )

  const expectedFinalTitles = toNumber(
    stats.expectedFinalTitles,
    totalRows * requestedTitleCount
  )

  const generatedTitleCount = toNumber(
    stats.generatedTitleCount ?? job.totalGeneratedTitles ?? job.total_generated_titles,
    0
  )

  const titleCreated = toNumber(titleStats.created, 0)
  const webflowCreatedItemCount = toNumber(
    stats.webflowCreatedItemCount ?? job.totalCreatedItems ?? job.total_created_items,
    titleCreated
  )

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

    // New title-level statuses.
    titleStaged: toNumber(titleStats.staged ?? titleStats.ready, 0),
    titleCreating: toNumber(titleStats.creating, 0),
    titleCreated,
    titleError: toNumber(titleStats.error, 0),
    titleSkipped: toNumber(titleStats.skipped, 0),
    titleDeleted: toNumber(titleStats.deleted, 0),

    webflowCreatedItemCount,

    // Legacy-only values. Kept for logs if older edge function versions return them.
    webflowNotReady: toNumber(titleStats.notReady ?? titleStats.not_ready, 0),
    webflowQueued: toNumber(titleStats.queued, 0),
    webflowPartialCreated: toNumber(titleStats.partialCreated ?? titleStats.partial_created, 0),
    webflowResultCount: toNumber(stats.webflowResultCount, 0),
    researchCompletedCount: toNumber(stats.researchCompletedCount, 0),
    researchErrorCount: toNumber(stats.researchErrorCount, 0)
  }
}

function buildRequestBody(action) {
  const body = {
    action,
    workerId: WORKER_ID,
    workerBatchSize: BATCH_SIZE,
    workerConcurrency: CONCURRENCY,
    maxWorkerSeconds: MAX_WORKER_SECONDS,
    resetStaleMinutes: RESET_STALE_MINUTES,
    includeRows: false,
    includeTitles: false
  }

  if (JOB_ID && JOB_ID.trim()) {
    body.jobId = JOB_ID.trim()
  }

  return body
}

async function callEdge(action) {
  const body = buildRequestBody(action)

  const response = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": WORKER_SECRET
    },
    body: JSON.stringify(body)
  })

  const text = await response.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(
      `Edge Function returned non-JSON response: ${text.slice(0, 2000)}`
    )
  }

  if (!response.ok || data.success === false) {
    throw new Error(JSON.stringify(data, null, 2))
  }

  return data
}

function generationDone(stats) {
  return (
    stats.totalRows > 0 &&
    stats.rowSuccess === stats.totalRows &&
    stats.rowPending === 0 &&
    stats.rowQueued === 0 &&
    stats.rowRunning === 0 &&
    stats.rowError === 0 &&
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
    stats.titleCreating === 0 &&
    stats.titleError === 0
  )
}

function logProgress(label, data) {
  const stats = getStats(data)

  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        phase: PHASE,
        label,
        configuredJobId: JOB_ID || null,
        activeJobId: getActiveJobId(data),
        autoDiscoveryEnabled: !JOB_ID,
        message: data.message || null,
        processedCount: data.processedCount ?? null,
        claimedTotal: data.claimedTotal ?? null,
        staleResetCount: data.staleResetCount ?? null,
        totalRows: stats.totalRows,
        requestedTitleCount: stats.requestedTitleCount,
        generatedTitleCount: stats.generatedTitleCount,
        expectedFinalTitles: stats.expectedFinalTitles,
        errorCount: stats.errorCount,
        research: {
          completed: stats.researchCompletedCount,
          errors: stats.researchErrorCount
        },
        rows: {
          success: stats.rowSuccess,
          pending: stats.rowPending,
          queued: stats.rowQueued,
          running: stats.rowRunning,
          error: stats.rowError,
          skipped: stats.rowSkipped
        },
        titles: {
          staged: stats.titleStaged,
          creating: stats.titleCreating,
          created: stats.titleCreated,
          createdItems: stats.webflowCreatedItemCount,
          error: stats.titleError,
          skipped: stats.titleSkipped,
          deleted: stats.titleDeleted
        },
        legacyWebflow: {
          notReady: stats.webflowNotReady,
          queued: stats.webflowQueued,
          partialCreated: stats.webflowPartialCreated,
          resultCount: stats.webflowResultCount
        }
      },
      null,
      2
    )
  )

  return stats
}

async function runGenerateLoop() {
  const data = await callEdge("worker_tick")
  const stats = logProgress("generation_tick_complete", data)

  if (!getActiveJobId(data) && Number(data.claimedTotal || 0) === 0) {
    console.log("No pending generation job found. Sleeping before checking again.")
    await sleep(IDLE_SLEEP_MS)
    return
  }

  if (STOP_ON_ERRORS && stats.rowError > 0) {
    console.error(
      "Generation errors found. Stopping so you can review/reset failed rows."
    )
    process.exit(1)
  }

  if (generationDone(stats)) {
    console.log("Generation complete for active job. All rows have generated titles.")

    if (KEEP_ALIVE_WHEN_DONE) {
      await sleep(IDLE_SLEEP_MS)
      return
    }

    process.exit(0)
  }

  const noWorkClaimed = Number(data.claimedTotal || 0) === 0

  if (noWorkClaimed) {
    await sleep(IDLE_SLEEP_MS)
  } else {
    await sleep(SLEEP_MS)
  }
}

async function runWebflowLoop() {
  const data = await callEdge("send_to_webflow")
  const stats = logProgress("webflow_tick_complete", data)

  if (!getActiveJobId(data) && Number(data.claimedTotal || 0) === 0) {
    console.log("No staged/error Webflow title records found. Sleeping before checking again.")
    await sleep(IDLE_SLEEP_MS)
    return
  }

  if (STOP_ON_ERRORS && stats.titleError > 0) {
    console.error(
      "Webflow title errors found. Stopping so you can review/reset failed title records."
    )
    process.exit(1)
  }

  if (webflowDone(stats)) {
    console.log("Webflow creation complete for active job. All generated titles have created CMS items.")

    if (KEEP_ALIVE_WHEN_DONE) {
      await sleep(IDLE_SLEEP_MS)
      return
    }

    process.exit(0)
  }

  const noWorkClaimed = Number(data.claimedTotal || 0) === 0

  if (noWorkClaimed) {
    await sleep(IDLE_SLEEP_MS)
  } else {
    await sleep(SLEEP_MS)
  }
}

async function main() {
  console.log(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        event: "worker_starting",
        phase: PHASE,
        workerId: WORKER_ID,
        configuredJobId: JOB_ID || null,
        autoDiscoveryEnabled: !JOB_ID,
        batchSize: BATCH_SIZE,
        concurrency: CONCURRENCY,
        maxWorkerSeconds: MAX_WORKER_SECONDS,
        resetStaleMinutes: RESET_STALE_MINUTES,
        stopOnErrors: STOP_ON_ERRORS,
        keepAliveWhenDone: KEEP_ALIVE_WHEN_DONE,
        normalizedTables: {
          jobs: "webflow_blog_title_creation_generation_jobs",
          rows: "webflow_blog_title_creation_generation_rows",
          titles: "webflow_blog_title_creation_generation_titles"
        }
      },
      null,
      2
    )
  )

  if (!["generate", "webflow"].includes(PHASE)) {
    throw new Error(`Invalid PHASE: ${PHASE}. Use "generate" or "webflow".`)
  }

  while (true) {
    try {
      if (PHASE === "generate") {
        await runGenerateLoop()
        continue
      }

      if (PHASE === "webflow") {
        await runWebflowLoop()
        continue
      }
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            time: new Date().toISOString(),
            event: "worker_error",
            phase: PHASE,
            workerId: WORKER_ID,
            configuredJobId: JOB_ID || null,
            autoDiscoveryEnabled: !JOB_ID,
            error: error?.message || String(error)
          },
          null,
          2
        )
      )

      await sleep(ERROR_SLEEP_MS)
    }
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        time: new Date().toISOString(),
        event: "fatal_worker_error",
        error: error?.message || String(error)
      },
      null,
      2
    )
  )

  process.exit(1)
})
