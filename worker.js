const EDGE_FUNCTION_URL = mustGetEnv("EDGE_FUNCTION_URL")
const WORKER_SECRET = mustGetEnv("WORKER_SECRET")
const JOB_ID = mustGetEnv("JOB_ID")

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
    expectedFinalTitles: Number(stats.expectedFinalTitles || 0),
    generatedTitleCount: Number(stats.generatedTitleCount || 0),

    generationPending: Number(generation.pending || 0),
    generationQueued: Number(generation.queued || 0),
    generationRunning: Number(generation.running || 0),
    generationSuccess: Number(generation.success || 0),
    generationError: Number(generation.error || 0),

    webflowNotReady: Number(webflow.notReady || 0),
    webflowReady: Number(webflow.ready || 0),
    webflowQueued: Number(webflow.queued || 0),
    webflowCreating: Number(webflow.creating || 0),
    webflowCreated: Number(webflow.created || 0),
    webflowPartialCreated: Number(webflow.partialCreated || 0),
    webflowError: Number(webflow.error || 0),
    webflowCreatedItemCount: Number(stats.webflowCreatedItemCount || 0)
  }
}

async function callEdge(action) {
  const response = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": WORKER_SECRET
    },
    body: JSON.stringify({
      action,
      jobId: JOB_ID,
      workerId: WORKER_ID,
      workerBatchSize: BATCH_SIZE,
      workerConcurrency: CONCURRENCY,
      maxWorkerSeconds: MAX_WORKER_SECONDS,
      resetStaleMinutes: RESET_STALE_MINUTES,
      includeRows: false
    })
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

async function getJob() {
  return await callEdge("get_job")
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
    jobId: JOB_ID,
    processedCount: data.processedCount ?? null,
    claimedTotal: data.claimedTotal ?? null,
    totalRows: stats.totalRows,
    generatedTitleCount: stats.generatedTitleCount,
    expectedFinalTitles: stats.expectedFinalTitles,
    generation: {
      success: stats.generationSuccess,
      pending: stats.generationPending,
      queued: stats.generationQueued,
      running: stats.generationRunning,
      error: stats.generationError
    },
    webflow: {
      createdRows: stats.webflowCreated,
      createdItems: stats.webflowCreatedItemCount,
      ready: stats.webflowReady,
      queued: stats.webflowQueued,
      creating: stats.webflowCreating,
      partialCreated: stats.webflowPartialCreated,
      error: stats.webflowError
    }
  }, null, 2))

  return stats
}

async function main() {
  console.log(`Starting ${PHASE} worker for job ${JOB_ID}`)

  while (true) {
    try {
      const action = PHASE === "webflow" ? "send_to_webflow" : "worker_tick"
      const data = await callEdge(action)
      const stats = logProgress("tick_complete", data)

      if (PHASE === "generate") {
        if (STOP_ON_ERRORS && stats.generationError > 0) {
          console.error("Generation errors found. Stopping so you can review/reset failed rows.")
          process.exit(1)
        }

        if (generationDone(stats)) {
          console.log("Generation complete. All rows have generated titles.")

          if (KEEP_ALIVE_WHEN_DONE) {
            await sleep(IDLE_SLEEP_MS)
            continue
          }

          process.exit(0)
        }

        const noWorkClaimed = Number(data.claimedTotal || 0) === 0
        if (noWorkClaimed) {
          await sleep(IDLE_SLEEP_MS)
        } else {
          await sleep(SLEEP_MS)
        }

        continue
      }

      if (PHASE === "webflow") {
        if (STOP_ON_ERRORS && (stats.webflowError > 0 || stats.webflowPartialCreated > 0)) {
          console.error("Webflow errors found. Stopping so you can review/reset failed rows.")
          process.exit(1)
        }

        if (webflowDone(stats)) {
          console.log("Webflow creation complete.")

          if (KEEP_ALIVE_WHEN_DONE) {
            await sleep(IDLE_SLEEP_MS)
            continue
          }

          process.exit(0)
        }

        const noWorkClaimed = Number(data.claimedTotal || 0) === 0
        if (noWorkClaimed) {
          await sleep(IDLE_SLEEP_MS)
        } else {
          await sleep(SLEEP_MS)
        }

        continue
      }

      throw new Error(`Unknown PHASE: ${PHASE}`)
    } catch (error) {
      console.error(JSON.stringify({
        time: new Date().toISOString(),
        phase: PHASE,
        jobId: JOB_ID,
        error: error.message || String(error)
      }, null, 2))

      await sleep(ERROR_SLEEP_MS)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
