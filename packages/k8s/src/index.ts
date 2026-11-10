import * as core from '@actions/core'
import {
  Command,
  getInputFromStdin,
  PrepareJobArgs,
  RunContainerStepArgs,
  RunScriptStepArgs
} from 'hooklib'
import {
  cleanupJob,
  prepareJob,
  runContainerStep,
  runScriptStep
} from './hooks'
import {
  getPodByName,
  isAuthPermissionsOK,
  namespace,
  requiredPermissions
} from './k8s'
import { logRunnerPlacement } from './k8s/placement'

// The runner's job-started hook (job-started.sh, ACTIONS_RUNNER_HOOK_JOB_STARTED)
// runs this bundle as `index.js job-started`, for every job — with a container
// or without: it says which node the runner pod runs on. It reads no stdin and
// never fails the job.
export const JOB_STARTED = 'job-started'

async function jobStarted(): Promise<void> {
  try {
    await logRunnerPlacement(getPodByName)
  } catch (error) {
    core.debug(`job-started: ${String(error)}`)
  }
  process.exit(0)
}

async function run(): Promise<void> {
  if (process.argv[2] === JOB_STARTED) {
    return jobStarted()
  }
  try {
    const input = await getInputFromStdin()

    const args = input['args']
    const command = input['command']
    const responseFile = input['responseFile']
    const state = input['state']
    if (!(await isAuthPermissionsOK())) {
      throw new Error(
        `The Service account needs the following permissions ${JSON.stringify(
          requiredPermissions
        )} on the pod resource in the '${namespace()}' namespace. Please contact your self hosted runner administrator.`
      )
    }

    let exitCode = 0
    switch (command) {
      case Command.PrepareJob:
        await prepareJob(args as PrepareJobArgs, responseFile)
        return process.exit(0)
      case Command.CleanupJob:
        await cleanupJob()
        return process.exit(0)
      case Command.RunScriptStep:
        exitCode = await runScriptStep(args as RunScriptStepArgs, state)
        return process.exit(exitCode)
      case Command.RunContainerStep:
        exitCode = await runContainerStep(args as RunContainerStepArgs)
        return process.exit(exitCode)
      default:
        throw new Error(`Command not recognized: ${command}`)
    }
  } catch (error) {
    core.error(error as Error)
    process.exit(1)
  }
}

void run()
