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
  mergeTempDirCommand
} from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'
import * as shlex from 'shlex'

export async function runScriptStep(
  args: RunScriptStepArgs,
  state
): Promise<void> {
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

  // Execute the entrypoint script
  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  try {
    await execPodStep(
      [args.entryPoint, ...args.entryPointArgs],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`execPodStep failed: ${message}`)
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    try {
      fs.rmSync(runnerPath, { force: true })
    } catch (removeErr) {
      core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
    }
  }

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
    core.warning('Failed to copy _temp from pod')
  }
}
