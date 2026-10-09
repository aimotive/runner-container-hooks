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
