/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import { execCpFromPod, execCpToPod, execPodStep } from '../k8s'
import {
  formatError,
  writeRunScript,
  sleep,
  listDirAllCommand,
  mergeTempDirCommand,
  exitCodeOf,
  exitCodeHint,
  slowSyncNotice
} from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'
import * as shlex from 'shlex'

const secondsSince = (start: number): number => (Date.now() - start) / 1000

// Returns the exit code of the step's own command (0 on success). An error is
// thrown only when the hook itself fails, not when the step's command does.
export async function runScriptStep(
  args: RunScriptStepArgs,
  state
): Promise<number> {
  // Write the entrypoint first. This will be later coppied to the workflow pod
  const { entryPoint, entryPointArgs, environmentVariables } = args
  const { containerPath, runnerPath } = writeRunScript(
    args.workingDirectory,
    entryPoint,
    entryPointArgs,
    args.prependPath,
    environmentVariables
  )

  const workdir = dirname(process.env.RUNNER_WORKSPACE as string)
  const runnerTemp = `${workdir}/_temp`
  const containerTemp = '/__w/_temp'
  const containerTempSrc = '/__w/_temp_pre'
  const syncInStart = Date.now()
  // execCpToPod creates the staging dir itself, so no separate mkdir exec.
  await execCpToPod(state.jobPod, runnerTemp, containerTempSrc)

  try {
    await execPodStep(
      ['sh', '-c', mergeTempDirCommand(containerTempSrc, containerTemp)],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`Failed to merge temp directories: ${message}`)
    throw new Error(`failed to merge temp dirs: ${message}`)
  }
  const syncIn = secondsSince(syncInStart)

  // Execute the entrypoint script
  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  let exitCode = 0
  const scriptStart = Date.now()
  try {
    await execPodStep(
      [args.entryPoint, ...args.entryPointArgs],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const code = exitCodeOf(err)
    if (code === undefined) {
      const message = formatError(err)
      core.debug(`execPodStep failed: ${message}`)
      throw new Error(`failed to run script step: ${message}`)
    }
    // The step's command itself failed. Pass its exit code on, so the runner
    // reports "Process completed with exit code N" as for any other step, and
    // still copy its file commands back below: the runner also reads the
    // outputs, env and step summary of failed steps.
    exitCode = code
  } finally {
    try {
      fs.rmSync(runnerPath, { force: true })
    } catch (removeErr) {
      core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
    }
  }

  const scriptSeconds = secondsSince(scriptStart)

  const syncOutStart = Date.now()
  try {
    core.debug(
      `Copying from job pod '${state.jobPod}' ${containerTemp} to ${runnerTemp}`
    )
    await execCpFromPod(
      state.jobPod,
      `${containerTemp}/_runner_file_commands`,
      `${workdir}/_temp`
    )
  } catch (error) {
    core.warning(
      `Could not copy this step's file commands back from the job pod; outputs, ` +
        `environment variables and the step summary it set may be missing: ${formatError(error)}`
    )
  }
  const syncOut = secondsSince(syncOutStart)

  core.debug(
    `[timing] sync in ${syncIn.toFixed(2)}s, script ${scriptSeconds.toFixed(2)}s, sync out ${syncOut.toFixed(2)}s`
  )
  for (const message of [
    slowSyncNotice(syncIn, syncOut),
    exitCodeHint(exitCode)
  ]) {
    if (message) {
      core.info(message)
    }
  }
  return exitCode
}
