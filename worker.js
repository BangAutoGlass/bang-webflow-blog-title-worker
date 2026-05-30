const EDGE_FUNCTION_URL = mustGetEnv("EDGE_FUNCTION_URL")
const WORKER_SECRET = mustGetEnv("WORKER_SECRET")

// JOB_ID is now optional.
// If blank/missing, the Supabase Edge Function will auto-discover the next pending job.
const JOB_ID = process.env.JOB_ID || ""

const PHASE = process.env.PHASE || "generate"
// PHASE options:
// generate = generate titles only
// webflow = send generated titles to Webflow only

const WORKER_ID = process.env.WORKER_ID || `render-${PHASE}-worker`

const BATCH_SIZE = numberEnv("BATCH_SIZE", 1)
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

function getStats(data) {
  const stats = data?.job?.stats || {}
  const generation = stats.generation || {}
  const webflow = stats.webflow || {}

  return {
    totalRows: Number(stats.totalRows || 0),
    requestedTitleCount: Number(stats.requestedTitleCount || 5),
    expectedFinalTitles: Number(stats.expectedFinalTitles || 0),
    generatedTitleCount: Number(stats.generatedTitleCount || 0),

    generationPending: Number(generation.pending || 0),
    generationQueued: Number(generation.queued || 0),
    generationRunning: Number(generation.running || 0),
    generationSuccess: Number(generation.success || 0),
    generationError: Number(generation.error || 0),
    generationSkipped: Number(generation.skipped || 0),
    generationCancelled: Number(generation.cancelled || 0),

    webflowNotReady: Number(webflow.notReady || 0),
    webflowReady: Number(webflow.ready || 0),
    webflowQueued: Number(webflow.queued || 0),
    webflowCreating: Number(webflow.creating || 0),
    webflowCreated: Number(webflow.created || 0),
    webflowPartialCreated: Number(webflow.partialCreated || 0),
    webflowError: Number(webflow.error || 0),
    webflowSkipped: Number(webflow.skipped || 0),
    webflowCancelled: Number(webflow.cancelled || 0),

    webflowCreatedItemCount: Number(stats.webflowCreatedItemCount || 0),
    webflowResultCount: Number(stats.webflowResultCount || 0),
    researchCompletedCount: Number(stats.researchCompletedCount || 0),
    researchErrorCount: Number(stats.researchErrorCount || 0)
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
    includeRows: false
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
    throw new Error(`Edge Function returned non-JSON response: ${text.slice(0, 2000)}`)
  }

  if (!response.ok || data.success === false) {
    throw new Error(JSON.stringify(data, null, 2))
  }

  return data
}

function generationDone(stats) {
  return (
    stats.totalRows > 0 &&
    stats.generationSuccess === stats.totalRows &&
    stats.generationPending === 0 &&
    stats.generationQueued === 0 &&
    stats.generationRunning === 0 &&
    stats.generationError === 0 &&
    stats.generatedTitleCount === stats.expectedFinalTitles
  )
}

function webflowDone(stats) {
  return (
    stats.totalRows > 0 &&
    stats.webflowCreated === stats.totalRows &&
    stats.webflowReady === 0 &&
    stats.webflowQueued === 0 &&
    stats.webflowCreating === 0 &&
    stats.webflowError === 0 &&
    stats.webflowPartialCreated === 0
  )
}

function logProgress(label, data) {
  const stats = getStats(data)

  console.log(JSON.stringify({
    time: new Date().toISOString(),
    phase: PHASE,
    label,
    configuredJobId: JOB_ID || null,
    activeJobId: data.jobId || data?.job?.jobId || null,
    autoDiscoveryEnabled: !JOB_ID,
    message: data.message || null,
    processedCount: data.processedCount ?? null,
    claimedTotal: data.claimedTotal ?? null,
    staleResetCount: data.staleResetCount ?? null,
    totalRows: stats.totalRows,
    requestedTitleCount: stats.requestedTitleCount,
    generatedTitleCount: stats.generatedTitleCount,
    expectedFinalTitles: stats.expectedFinalTitles,
    research: {
      completed: stats.researchCompletedCount,
      errors: stats.researchErrorCount
    },
    generation: {
      success: stats.generationSuccess,
      pending: stats.generationPending,
      queued: stats.generationQueued,
      running: stats.generationRunning,
      error: stats.generationError,
      skipped: stats.generationSkipped,
      cancelled: stats.generationCancelled
    },
    webflow: {
      createdRows: stats.webflowCreated,
      createdItems: stats.webflowCreatedItemCount,
      resultCount: stats.webflowResultCount,
      notReady: stats.webflowNotReady,
      ready: stats.webflowReady,
      queued: stats.webflowQueued,
      creating: stats.webflowCreating,
      partialCreated: stats.webflowPartialCreated,
      error: stats.webflowError,
      skipped: stats.webflowSkipped,
      cancelled: stats.webflowCancelled
    }
  }, null, 2))

  return stats
}

async function runGenerateLoop() {
  const data = await callEdge("worker_tick")
  const stats = logProgress("generation_tick_complete", data)

  if (!data.jobId && Number(data.claimedTotal || 0) === 0) {
    console.log("No pending generation job found. Sleeping before checking again.")
    await sleep(IDLE_SLEEP_MS)
    return
  }

  if (STOP_ON_ERRORS && stats.generationError > 0) {
    console.error("Generation errors found. Stopping so you can review/reset failed rows.")
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

  if (!data.jobId && Number(data.claimedTotal || 0) === 0) {
    console.log("No Webflow-ready job found. Sleeping before checking again.")
    await sleep(IDLE_SLEEP_MS)
    return
  }

  if (STOP_ON_ERRORS && (stats.webflowError > 0 || stats.webflowPartialCreated > 0)) {
    console.error("Webflow errors found. Stopping so you can review/reset failed rows.")
    process.exit(1)
  }

  if (webflowDone(stats)) {
    console.log("Webflow creation complete for active job.")

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
  console.log(JSON.stringify({
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
    keepAliveWhenDone: KEEP_ALIVE_WHEN_DONE
  }, null, 2))

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
      console.error(JSON.stringify({
        time: new Date().toISOString(),
        event: "worker_error",
        phase: PHASE,
        workerId: WORKER_ID,
        configuredJobId: JOB_ID || null,
        autoDiscoveryEnabled: !JOB_ID,
        error: error?.message || String(error)
      }, null, 2))

      await sleep(ERROR_SLEEP_MS)
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    event: "fatal_worker_error",
    error: error?.message || String(error)
  }, null, 2))

  process.exit(1)
})
