import * as core from '@actions/core'
import { formatError } from './utils'

// Where a job runs: the node Kubernetes put a pod on. A runner pod is not told
// its own node (no NODE_NAME in its spec), and GitHub only knows the pod's name
// — so the hooks, which may read pods in their namespace anyway, look it up and
// print it into the job's log, where a reader (or the workflow dashboard) finds
// it. Best-effort throughout: a job never fails on it.

// A namespaced get-by-name of a pod: the same read the hooks' role already allows.
export type PodReader = (
  name: string
) => Promise<{ spec?: { nodeName?: string } }>

export const ENV_RUNNER_POD_NAME = 'ACTIONS_RUNNER_POD_NAME'

// The line a reader looks for, the same shape as the job pod's:
//   Runner pod <pod> is running on node <node>
export function runnerPlacementLine(pod: string, node: string): string {
  return `Runner pod ${pod} is running on node ${node}`
}

// Print the node the runner pod runs on. For a job without a container that is
// where its steps run; for one with a container it is where the runner that
// drives the workflow pod runs.
export async function logRunnerPlacement(
  read: PodReader,
  pod: string | undefined = process.env[ENV_RUNNER_POD_NAME]
): Promise<string | undefined> {
  if (!pod) {
    core.debug(
      `${ENV_RUNNER_POD_NAME} is not set: the runner pod's node cannot be read`
    )
    return undefined
  }
  try {
    const node = (await read(pod)).spec?.nodeName
    if (node) {
      core.info(runnerPlacementLine(pod, node))
      return node
    }
    core.debug(`Runner pod ${pod} has no node in its spec`)
  } catch (err) {
    core.debug(
      `Could not read the node of runner pod ${pod}: ${formatError(err)}`
    )
  }
  return undefined
}

// When a job's pod got to its work, by the pod's own times: the API server's
// for its creation, the scheduler's for its node, the kubelet's for its
// containers. The hooks measure none of it: they read the pod's status once it
// runs and print one line, for a reader (or the workflow dashboard) to split
// the job's start by:
//   [pod] created=<RFC3339> scheduled=<RFC3339> init_started=<RFC3339> initialized=<RFC3339> started=<RFC3339>
// A time the pod does not have is left out. A pod that had no node at first
// says why after a bar, in the scheduler's words:
//   [pod] created=… started=… | Unschedulable: 0/31 nodes are available: …

type Moment = Date | string | undefined

interface ContainerTimes {
  name: string
  state?: {
    running?: { startedAt?: Moment }
    terminated?: { startedAt?: Moment }
  }
}

// What of a pod the line is made of: a V1Pod, or as much of one.
export interface PodTimes {
  metadata?: { name?: string; creationTimestamp?: Moment }
  status?: {
    conditions?: {
      type: string
      status: string
      lastTransitionTime?: Moment
      reason?: string
      message?: string
    }[]
    initContainerStatuses?: ContainerTimes[]
    containerStatuses?: ContainerTimes[]
  }
}

// Why a pod has no node: its PodScheduled condition, while that is false.
export interface PodHeld {
  reason: string
  message: string
}

const HELD_MESSAGE_LENGTH = 300
const held = new Map<string, PodHeld>()

// Remember why a pod waits for a node, each time it is read while it waits:
// its condition says so only until the pod has one.
export function notePodHeld(pod: PodTimes): void {
  const name = pod.metadata?.name
  const scheduled = pod.status?.conditions?.find(c => c.type === 'PodScheduled')
  if (!name || scheduled?.status !== 'False' || !scheduled.reason) {
    return
  }
  held.set(name, {
    reason: scheduled.reason,
    message: (scheduled.message || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, HELD_MESSAGE_LENGTH)
  })
}

export function podHeld(name: string | undefined): PodHeld | undefined {
  return name ? held.get(name) : undefined
}

// A Kubernetes time as the API writes it, to the second: 2026-11-10T12:00:03Z
function rfc3339(moment: Moment): string | undefined {
  if (!moment) {
    return undefined
  }
  const date = moment instanceof Date ? moment : new Date(moment)
  return isNaN(date.getTime())
    ? undefined
    : date.toISOString().replace(/\.\d+Z$/, 'Z')
}

export function podTimesLine(
  pod: PodTimes,
  jobContainer: string,
  wasHeld: PodHeld | undefined = podHeld(pod.metadata?.name)
): string | undefined {
  const turned = (type: string): Moment =>
    pod.status?.conditions?.find(c => c.type === type && c.status === 'True')
      ?.lastTransitionTime
  // The first of its init containers to start: these times compare as text.
  const initStarted = (pod.status?.initContainerStatuses || [])
    .map(c =>
      rfc3339(c.state?.terminated?.startedAt ?? c.state?.running?.startedAt)
    )
    .reduce(
      (first, at) => (at && (!first || at < first) ? at : first),
      undefined
    )
  const job = pod.status?.containerStatuses?.find(c => c.name === jobContainer)
  const times = [
    ['created', rfc3339(pod.metadata?.creationTimestamp)],
    ['scheduled', rfc3339(turned('PodScheduled'))],
    ['init_started', initStarted],
    ['initialized', rfc3339(turned('Initialized'))],
    ['started', rfc3339(job?.state?.running?.startedAt)]
  ].filter(([, at]) => at)
  if (!times.length) {
    return undefined
  }
  return (
    `[pod] ${times.map(([key, at]) => `${key}=${at}`).join(' ')}` +
    (wasHeld
      ? ` | ${wasHeld.reason}${wasHeld.message ? `: ${wasHeld.message}` : ''}`
      : '')
  )
}

// Print the pod's times, once it runs. Best-effort like the rest: a pod that
// says nothing, or something unexpected, costs the line and never the job.
export function logPodTimes(pod: PodTimes, jobContainer: string): void {
  try {
    const line = podTimesLine(pod, jobContainer)
    if (line) {
      core.info(line)
    }
  } catch (err) {
    core.debug(`Could not read the times of the job pod: ${formatError(err)}`)
  }
}
