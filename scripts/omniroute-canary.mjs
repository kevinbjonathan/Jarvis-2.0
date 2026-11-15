/**
 * Run the Stage E OmniRoute canary once.
 *
 * This is the deliberate test path: it sends one fixed synthetic prompt to the
 * one approved model and prints only safe metadata. It does not touch the
 * voice, browser, mail, calendar or normal chat routing.
 *
 *   npm run canary:omniroute
 *
 * Exit codes: 0 = canary verified, 1 = canary request failed, 2 = canary is
 * disabled or misconfigured (which is the default).
 */

import '../bridge/env.mjs'
import {
  describeOmniRouteCanary,
  runOmniRouteCanary,
  safeCanaryReport,
} from '../bridge/omniroute-canary.mjs'

const status = describeOmniRouteCanary()
if (status.state !== 'ready') {
  console.error(`OmniRoute canary is not ready (${status.state}): ${status.detail}`)
  process.exitCode = 2
} else {
  try {
    const report = await runOmniRouteCanary()
    console.log(JSON.stringify(safeCanaryReport(report), null, 2))
    process.exitCode = report.verified ? 0 : 1
  } catch (err) {
    console.error(`OmniRoute canary failed (${err?.code ?? 'unavailable'}).`)
    process.exitCode = 1
  }
}
