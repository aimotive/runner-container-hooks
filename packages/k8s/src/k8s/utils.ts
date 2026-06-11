import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as core from '@actions/core'
import { v1 as uuidv4 } from 'uuid'
import { CONTAINER_EXTENSION_PREFIX } from '../hooks/constants'
import * as shlex from 'shlex'
import { Mount } from 'hooklib'

export const DEFAULT_CONTAINER_ENTRY_POINT_ARGS = [`-f`, `/dev/null`]
export const DEFAULT_CONTAINER_ENTRY_POINT = 'tail'

export const ENV_HOOK_TEMPLATE_PATH = 'ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE'
export const ENV_USE_KUBE_SCHEDULER = 'ACTIONS_RUNNER_USE_KUBE_SCHEDULER'

export const EXTERNALS_VOLUME_NAME = 'externals'
export const GITHUB_VOLUME_NAME = 'github'
export const WORK_VOLUME = 'work'

export const ENV_WORK_VOLUME_STORAGE_CLASS =
  'ACTIONS_RUNNER_WORK_VOLUME_STORAGE_CLASS'
export const ENV_WORK_VOLUME_SIZE = 'ACTIONS_RUNNER_WORK_VOLUME_SIZE'
export const ENV_WORK_VOLUME_ACCESS_MODE =
  'ACTIONS_RUNNER_WORK_VOLUME_ACCESS_MODE'
export const DEFAULT_WORK_VOLUME_SIZE = '50Gi'
export const DEFAULT_WORK_VOLUME_ACCESS_MODE = 'ReadWriteOnce'

export const ENV_SKIP_CP_HASH_VERIFY = 'ACTIONS_RUNNER_SKIP_CP_HASH_VERIFY'

export const ENV_RELEASE_WORK_VOLUME_PV = 'ACTIONS_RUNNER_RELEASE_WORK_VOLUME_PV'

// When true, the cleanup-job hook releases the specific PV that backed this
// job's work volume: it reads the bound PV name from the work-volume PVC,
// deletes the pod (which garbage-collects the ephemeral PVC), waits for the PV
// to reach Released, and clears its claimRef so it returns to Available. This
// is a targeted, per-job release (no cluster-wide PV sweep) that — unlike a
// workflow-pod sidecar — runs from the runner side and so survives job
// cancellation. A low-frequency reaper still backstops hard-kill cases.
export function releaseWorkVolumePvEnabled(): boolean {
  return process.env[ENV_RELEASE_WORK_VOLUME_PV] === 'true'
}

export const ENV_REPORT_RESOURCE_USAGE = 'ACTIONS_RUNNER_REPORT_RESOURCE_USAGE'

// When true, the cleanup-job hook reads the job container's cgroup peak memory
// (and cumulative CPU) just before the pod is torn down and logs it, so the
// GitHub UI shows actual peak usage against the configured limits. Useful for
// right-sizing the podTemplate resources.
export function reportResourceUsageEnabled(): boolean {
  return process.env[ENV_REPORT_RESOURCE_USAGE] === 'true'
}

// Render a Kubernetes resources map (requests/limits) as a compact one-liner,
// e.g. "cpu=4 memory=5Gi". Values may arrive as numbers or strings.
export function formatResourceMap(map?: { [key: string]: unknown }): string {
  if (!map || !Object.keys(map).length) {
    return '(none)'
  }
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

// Turn the raw cgroup stdout (mem_peak=.., mem_limit=.., cpu_usec=../cpu_nsec=..)
// into a single human-readable usage line. Pure so it can be unit-tested
// independently of the in-cluster exec.
export function formatResourceUsageReport(raw: string): string {
  const fields: { [k: string]: string } = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }

  const memPeak = Number(fields['mem_peak'])
  // cgroup v1 reports an unlimited memory limit as a huge sentinel; treat
  // anything implausibly large (or the v2 literal "max") as "no limit".
  const memLimitRaw = fields['mem_limit']
  const memLimit = Number(memLimitRaw)
  const hasLimit =
    Number.isFinite(memLimit) &&
    memLimitRaw !== 'max' &&
    memLimit < 1024 ** 5 // < 1Pi → a real limit

  let memMsg: string
  if (Number.isFinite(memPeak)) {
    const peakStr = formatBytes(memPeak)
    if (hasLimit) {
      const pct = Math.round((memPeak / memLimit) * 100)
      memMsg = `peak memory: ${peakStr} / ${formatBytes(memLimit)} limit (${pct}%)`
    } else {
      memMsg = `peak memory: ${peakStr} (no limit)`
    }
  } else {
    memMsg = 'peak memory: n/a (no cgroup peak counter on this kernel)'
  }

  let cpuMsg = ''
  const cpuSec =
    fields['cpu_usec'] && fields['cpu_usec'] !== 'na'
      ? Number(fields['cpu_usec']) / 1e6
      : fields['cpu_nsec']
        ? Number(fields['cpu_nsec']) / 1e9
        : NaN
  if (Number.isFinite(cpuSec)) {
    cpuMsg = ` | cpu: ${Math.round(cpuSec * 10) / 10}s total`
  }

  return `${memMsg}${cpuMsg}`
}

// Human-readable bytes (binary units). Returns undefined for non-finite input.
export function formatBytes(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return undefined
  }
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10
  return `${rounded}${units[unit]}`
}

// When the work volume is a large, reused persistent volume, the per-copy
// integrity safeguards in execCpToPod/execCpFromPod walk the entire /__w tree
// file-by-file (a `find ... -exec stat` hash plus a `find ... -exec chmod`
// permission fixup). On a huge retained clone these forks-per-file never
// realistically finish, hanging "Initialize containers". Setting
// ACTIONS_RUNNER_SKIP_CP_HASH_VERIFY=true skips both whole-tree passes: the
// copy just extracts the (small) incoming delta and returns without verifying.
export function skipCpHashVerify(): boolean {
  return process.env[ENV_SKIP_CP_HASH_VERIFY] === 'true'
}

// Build the `work` volume that the job container mounts at /__w (see
// CONTAINER_VOLUMES). By default this is an emptyDir scoped to the pod's
// lifetime. When ACTIONS_RUNNER_WORK_VOLUME_STORAGE_CLASS is set, the volume
// instead becomes a generic ephemeral volume whose PVC is auto-created from
// that storage class. Backed by a statically-provisioned, Retain-policy local
// PV pool, this lets the workspace (e.g. the git clone produced by
// actions/checkout) persist on local disk and be reused across jobs.
export function buildWorkVolume(): k8s.V1Volume {
  const storageClass = process.env[ENV_WORK_VOLUME_STORAGE_CLASS]
  if (!storageClass) {
    return { name: WORK_VOLUME, emptyDir: {} }
  }
  const storage = process.env[ENV_WORK_VOLUME_SIZE] || DEFAULT_WORK_VOLUME_SIZE
  const accessMode =
    process.env[ENV_WORK_VOLUME_ACCESS_MODE] || DEFAULT_WORK_VOLUME_ACCESS_MODE
  return {
    name: WORK_VOLUME,
    ephemeral: {
      volumeClaimTemplate: {
        spec: {
          accessModes: [accessMode],
          storageClassName: storageClass,
          resources: {
            requests: {
              storage
            }
          }
        }
      }
    }
  }
}

export const ENV_NODE_PIN_FROM_PR_LABEL =
  'ACTIONS_RUNNER_NODE_PIN_FROM_PR_LABEL'
export const ENV_NODE_PIN_LABEL_PREFIX =
  'ACTIONS_RUNNER_NODE_PIN_LABEL_PREFIX'
export const DEFAULT_NODE_PIN_LABEL_PREFIX = 'ci:node:'

// Debug helper: when enabled, redirect the workflow pod to a specific node
// named by a pull-request label `ci:node:<nodename>` (prefix configurable).
// Returns the node name, or undefined when disabled, not a PR event, no
// matching label, or anything fails to parse (never breaks job prep).
// Applied as a `kubernetes.io/hostname` nodeSelector, so the scheduler still
// honours taints/resources (the pod stays Pending if the node can't take it).
export function getNodePinFromPrLabel(): string | undefined {
  if (process.env[ENV_NODE_PIN_FROM_PR_LABEL] !== 'true') {
    return undefined
  }
  const eventName = process.env['GITHUB_EVENT_NAME']
  const eventPath = process.env['GITHUB_EVENT_PATH']
  const prefix =
    process.env[ENV_NODE_PIN_LABEL_PREFIX] || DEFAULT_NODE_PIN_LABEL_PREFIX
  core.info(
    `[node-pin] enabled; event='${eventName ?? '(unset)'}' eventPath='${eventPath ?? '(unset)'}' prefix='${prefix}'`
  )

  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    core.info(`[node-pin] not a pull_request event; skipping`)
    return undefined
  }
  if (!eventPath) {
    core.info(`[node-pin] GITHUB_EVENT_PATH is unset; cannot read PR labels`)
    return undefined
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    const labels = payload?.pull_request?.labels
    if (!Array.isArray(labels)) {
      core.info(`[node-pin] no pull_request.labels array in event payload`)
      return undefined
    }
    const names = labels
      .map((l: { name?: string }) => l?.name)
      .filter((n: unknown): n is string => typeof n === 'string')
    core.info(`[node-pin] PR labels: ${names.join(', ') || '(none)'}`)

    const matches = names.filter(n => n.startsWith(prefix))
    if (!matches.length) {
      core.info(`[node-pin] no label with prefix '${prefix}'`)
      return undefined
    }
    if (matches.length > 1) {
      core.warning(
        `[node-pin] multiple '${prefix}' labels found (${matches.join(', ')}); using the first`
      )
    }
    const node = matches[0].slice(prefix.length).trim()
    if (!node) {
      core.info(`[node-pin] label '${matches[0]}' has an empty node name`)
      return undefined
    }
    return node
  } catch (err) {
    core.warning(
      `[node-pin] could not read PR labels from ${eventPath}: ${(err as Error)?.message ?? err}`
    )
    return undefined
  }
}

export const ENV_ALLOW_JOB_RESOURCES = 'ACTIONS_RUNNER_ALLOW_JOB_RESOURCES'
// Workflow-facing env key (set in the workflow's `container.env`), NOT a
// RunnerSet env var. Holds a JSON V1ResourceRequirements object.
export const JOB_RESOURCES_ENV_KEY = 'K8S_JOB_RESOURCES'

// Let a workflow override the job container's resources from its own YAML
// (e.g. per matrix axis) via a JSON env var, without one RunnerSet per axis.
// `container.resources` is not valid GitHub Actions syntax and never reaches
// the hook, so the value is carried as an env var in `container.env`. Gated by
// the RunnerSet flag ACTIONS_RUNNER_ALLOW_JOB_RESOURCES so the admin controls
// whether workflows may set their own resources. Returns undefined (→ fall back
// to the podTemplate resources) when disabled, unset, or unparseable.
export function parseJobResourcesFromEnv(envVars?: {
  [key: string]: string
}): k8s.V1ResourceRequirements | undefined {
  if (process.env[ENV_ALLOW_JOB_RESOURCES] !== 'true') {
    return undefined
  }
  const raw = envVars?.[JOB_RESOURCES_ENV_KEY]
  if (!raw) {
    core.info(
      `[resources] ALLOW_JOB_RESOURCES enabled but ${JOB_RESOURCES_ENV_KEY} not present in the container env (${Object.keys(envVars ?? {}).length} env var(s) received); using podTemplate resources`
    )
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not an object')
    }
    if (parsed.requests === undefined && parsed.limits === undefined) {
      throw new Error('expected "requests" and/or "limits"')
    }
    core.info(`[resources] applying workflow-provided ${JOB_RESOURCES_ENV_KEY}`)
    return parsed as k8s.V1ResourceRequirements
  } catch (err) {
    core.warning(
      `[resources] ignoring invalid ${JOB_RESOURCES_ENV_KEY}: ${(err as Error)?.message ?? err}`
    )
    return undefined
  }
}

export const CONTAINER_VOLUMES: k8s.V1VolumeMount[] = [
  {
    name: EXTERNALS_VOLUME_NAME,
    mountPath: '/__e'
  },
  {
    name: WORK_VOLUME,
    mountPath: '/__w'
  },
  {
    name: GITHUB_VOLUME_NAME,
    mountPath: '/github'
  }
]

export function prepareJobScript(userVolumeMounts: Mount[]): {
  containerPath: string
  runnerPath: string
} {
  let mountDirs = userVolumeMounts.map(m => m.targetVolumePath).join(' ')

  const content = `#!/bin/sh -l
set -e
cp -R /__w/_temp/_github_home /github/home
cp -R /__w/_temp/_github_workflow /github/workflow
mkdir -p ${mountDirs}
`

  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeRunScript(
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  prependPath?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let exportPath = ''
  if (prependPath?.length) {
    // TODO: remove compatibility with typeof prependPath === 'string' as we bump to next major version, the hooks will lose PrependPath compat with runners 2.293.0 and older
    const prepend =
      typeof prependPath === 'string' ? prependPath : prependPath.join(':')
    exportPath = `export PATH=${prepend}:$PATH`
  }

  let environmentPrefix = scriptEnv(environmentVariables)

  const content = `#!/bin/sh -l
set -e
rm "$0" # remove script after running
${exportPath}
cd ${workingDirectory} && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeContainerStepScript(
  dst: string,
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let environmentPrefix = scriptEnv(environmentVariables)

  const parts = workingDirectory.split('/').slice(-2)
  if (parts.length !== 2) {
    throw new Error(`Invalid working directory: ${workingDirectory}`)
  }

  const content = `#!/bin/sh -l
rm "$0" # remove script after running
mv /__w/_temp/_github_home /github/home && \
mv /__w/_temp/_github_workflow /github/workflow && \
mv /__w/_temp/_runner_file_commands /github/file_commands || true && \
mv /__w/${parts.join('/')}/ /github/workspace && \
cd /github/workspace && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${uuidv4()}.sh`
  const entryPointPath = `${dst}/${filename}`
  core.debug(`Writing container step script to ${entryPointPath}`)
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

function scriptEnv(envs?: { [key: string]: string }): string {
  if (!envs || !Object.entries(envs).length) {
    return ''
  }
  const envBuffer: string[] = []
  for (const [key, value] of Object.entries(envs)) {
    if (
      key.includes(`=`) ||
      key.includes(`'`) ||
      key.includes(`"`) ||
      key.includes(`$`)
    ) {
      throw new Error(
        `environment key ${key} is invalid - the key must not contain =, $, ', or "`
      )
    }
    envBuffer.push(
      `"${key}=${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')}"`
    )
  }

  if (!envBuffer?.length) {
    return ''
  }

  return `env ${envBuffer.join(' ')} `
}

export function generateContainerName(image: string): string {
  const nameWithTag = image.split('/').pop()
  const name = nameWithTag?.split(':')[0]

  if (!name) {
    throw new Error(`Image definition '${image}' is invalid`)
  }

  return name
}

// Overwrite or append based on container options
//
// Keep in mind, envs and volumes could be passed as fields in container definition
// so default volume mounts and envs are appended first, and then create options are used
// to append more values
//
// Rest of the fields are just applied
// For example, container.createOptions.container.image is going to overwrite container.image field
export function mergeContainerWithOptions(
  base: k8s.V1Container,
  from: k8s.V1Container
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'name') {
      if (value !== CONTAINER_EXTENSION_PREFIX + base.name) {
        core.warning("Skipping name override: name can't be overwritten")
      }
      continue
    } else if (key === 'image') {
      core.warning("Skipping image override: image can't be overwritten")
      continue
    } else if (key === 'env') {
      const envs = value as k8s.V1EnvVar[]
      base.env = mergeLists(base.env, envs)
    } else if (key === 'volumeMounts' && value) {
      const volumeMounts = value as k8s.V1VolumeMount[]
      base.volumeMounts = mergeLists(base.volumeMounts, volumeMounts)
    } else if (key === 'ports' && value) {
      const ports = value as k8s.V1ContainerPort[]
      base.ports = mergeLists(base.ports, ports)
    } else {
      base[key] = value
    }
  }
}

export function mergePodSpecWithOptions(
  base: k8s.V1PodSpec,
  from: k8s.V1PodSpec
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'containers') {
      base.containers.push(
        ...from.containers.filter(
          e => !e.name?.startsWith(CONTAINER_EXTENSION_PREFIX)
        )
      )
    } else if (key === 'volumes' && value) {
      const volumes = value as k8s.V1Volume[]
      base.volumes = mergeLists(base.volumes, volumes)
    } else {
      base[key] = value
    }
  }
}

export function mergeObjectMeta(
  base: { metadata?: k8s.V1ObjectMeta },
  from: k8s.V1ObjectMeta
): void {
  if (!base.metadata?.labels || !base.metadata?.annotations) {
    throw new Error(
      "Can't merge metadata: base.metadata or base.annotations field is undefined"
    )
  }
  if (from?.labels) {
    for (const [key, value] of Object.entries(from.labels)) {
      if (base.metadata?.labels?.[key]) {
        core.warning(`Label ${key} is already defined and will be overwritten`)
      }
      base.metadata.labels[key] = value
    }
  }

  if (from?.annotations) {
    for (const [key, value] of Object.entries(from.annotations)) {
      if (base.metadata?.annotations?.[key]) {
        core.warning(
          `Annotation ${key} is already defined and will be overwritten`
        )
      }
      base.metadata.annotations[key] = value
    }
  }
}

export function readExtensionFromFile(): k8s.V1PodTemplateSpec | undefined {
  const filePath = process.env[ENV_HOOK_TEMPLATE_PATH]
  if (!filePath) {
    return undefined
  }
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Failed to parse ${filePath}`)
  }
  return doc as k8s.V1PodTemplateSpec
}

export function useKubeScheduler(): boolean {
  return process.env[ENV_USE_KUBE_SCHEDULER] === 'true'
}

export enum PodPhase {
  PENDING = 'Pending',
  RUNNING = 'Running',
  SUCCEEDED = 'Succeeded',
  FAILED = 'Failed',
  UNKNOWN = 'Unknown',
  COMPLETED = 'Completed'
}

function mergeLists<T>(base?: T[], from?: T[]): T[] {
  const b: T[] = base || []
  if (!from?.length) {
    return b
  }
  b.push(...from)
  return b
}

export function fixArgs(args: string[]): string[] {
  // Preserve shell command strings passed via `sh -c` without re-tokenizing.
  // Retokenizing would split the script into multiple args, breaking `sh -c`.
  if (args.length >= 2 && args[0] === 'sh' && args[1] === '-c') {
    return args
  }
  return shlex.split(args.join(' '))
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function listDirAllCommand(dir: string): string {
  return `cd ${shlex.quote(dir)} && find . -not -path '*/_runner_hook_responses*' -exec stat -c '%s %n' {} \\;`
}
