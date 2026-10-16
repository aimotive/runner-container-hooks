import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as core from '@actions/core'
import { v1 as uuidv4 } from 'uuid'
import { CONTAINER_EXTENSION_PREFIX } from '../hooks/constants'
import * as shlex from 'shlex'
import * as stream from 'stream'
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

export const ENV_RELEASE_WORK_VOLUME_PV =
  'ACTIONS_RUNNER_RELEASE_WORK_VOLUME_PV'

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

// When true, the prepare-job hook starts a small sampler in the job container
// and the cleanup-job hook reads what it saw, with the cgroup's own peak and
// the cumulative CPU, just before the pod is torn down, and logs it, so the
// GitHub UI shows actual peak usage against the configured limits. Useful for
// right-sizing the podTemplate resources.
export function reportResourceUsageEnabled(): boolean {
  return process.env[ENV_REPORT_RESOURCE_USAGE] === 'true'
}

// The job container's cgroup (its cgroup namespace makes it the root) and the
// file in it the sampler keeps its peaks in.
export const JOB_CGROUP_DIR = '/sys/fs/cgroup'
export const USAGE_PEAKS_FILE = '/tmp/.runner-usage-peaks'
export const USAGE_SAMPLE_INTERVAL_SECONDS = 2

// cgroup v2's memory.peak is no measure of what a job needed: the page cache
// is in it, and the kernel lets the cache grow up to memory.max before it
// reclaims any, so a job that reads or writes more files than its limit (a
// checkout, a build, a package download) peaks at exactly its limit. Nor can
// the cache be taken out of the peak afterwards. So a sampler keeps two peaks
// of its own, from memory.current and memory.stat:
//   held         memory.current less the page cache (`file`, which counts tmpfs
//                and shm in, so `shmem` goes back in) and less the reclaimable
//                slab: what the kernel cannot give back without swap, what an
//                OOM kill is about.
//   working set  memory.current less the inactive page cache, the kubelet's
//                measure, which its evictions and workflow-dashboard's build
//                report go by.
// One sample: reads the peaks so far from the file, writes them back when a
// new sample beats them. POSIX sh and coreutils only: the job image is any.
export function usageSampleCommand(
  cgroupDir = JOB_CGROUP_DIR,
  peaksFile = USAGE_PEAKS_FILE
): string {
  const cg = shlex.quote(cgroupDir)
  const f = shlex.quote(peaksFile)
  return [
    `cur=$(cat ${cg}/memory.current 2>/dev/null) || exit 0`,
    'file=0 shmem=0 inactive=0 slab=0 held_peak=0 ws_peak=0',
    'while read -r k v; do',
    '  case $k in',
    '    file) file=$v ;; shmem) shmem=$v ;;',
    '    inactive_file) inactive=$v ;; slab_reclaimable) slab=$v ;;',
    '  esac',
    `done < ${cg}/memory.stat`,
    `[ -r ${f} ] && while IFS== read -r k v; do`,
    '  case $k in held_peak) held_peak=$v ;; ws_peak) ws_peak=$v ;; esac',
    `done < ${f}`,
    'held=$((cur - file + shmem - slab)); ws=$((cur - inactive))',
    'if [ "$held" -gt "$held_peak" ] || [ "$ws" -gt "$ws_peak" ]; then',
    '  [ "$held" -gt "$held_peak" ] && held_peak=$held',
    '  [ "$ws" -gt "$ws_peak" ] && ws_peak=$ws',
    `  printf 'held_peak=%s\\nws_peak=%s\\n' "$held_peak" "$ws_peak" > ${f}.tmp && mv ${f}.tmp ${f}`,
    'fi'
  ].join('\n')
}

// Starts the sampler in the background and returns at once. Its descriptors
// go to /dev/null so the exec's stream can close; the loop outlives the exec
// and ends with the container, or once its cgroup is unreadable. cgroup v1 has
// no memory.stat `file` to take the cache out with: there the sampler does not
// start, and the report says only the cgroup's peak.
export function usageSamplerStartCommand(
  cgroupDir = JOB_CGROUP_DIR,
  peaksFile = USAGE_PEAKS_FILE,
  intervalSeconds = USAGE_SAMPLE_INTERVAL_SECONDS
): string {
  const loop = [
    `while [ -r ${shlex.quote(`${cgroupDir}/memory.current`)} ]; do`,
    `( ${usageSampleCommand(cgroupDir, peaksFile)} )`,
    `sleep ${intervalSeconds}`,
    'done'
  ].join('\n')
  return [
    `[ -r ${shlex.quote(`${cgroupDir}/memory.stat`)} ] || exit 0`,
    `rm -f ${shlex.quote(peaksFile)}`,
    `sh -c ${shlex.quote(loop)} </dev/null >/dev/null 2>&1 &`
  ].join('\n')
}

// What the cleanup-job hook reads: the sampler's peaks (a last sample first,
// for whatever came after its last one), the cgroup's peak and limit, how
// often the job hit the limit and how many of its processes the OOM killer
// took, and its CPU time. cgroup v1 gives the peak, limit and CPU only.
export function usageReadCommand(
  cgroupDir = JOB_CGROUP_DIR,
  peaksFile = USAGE_PEAKS_FILE
): string {
  const cg = shlex.quote(cgroupDir)
  const f = shlex.quote(peaksFile)
  return `
if [ -r ${f} ]; then ( ${usageSampleCommand(cgroupDir, peaksFile)} ); cat ${f}; fi
if [ -r ${cg}/memory.peak ]; then echo "mem_peak=$(cat ${cg}/memory.peak)"; \
elif [ -r ${cg}/memory/memory.max_usage_in_bytes ]; then echo "mem_peak=$(cat ${cg}/memory/memory.max_usage_in_bytes)"; \
else echo "mem_peak=na"; fi
if [ -r ${cg}/memory.max ]; then echo "mem_limit=$(cat ${cg}/memory.max)"; \
elif [ -r ${cg}/memory/memory.limit_in_bytes ]; then echo "mem_limit=$(cat ${cg}/memory/memory.limit_in_bytes)"; \
else echo "mem_limit=na"; fi
if [ -r ${cg}/memory.events ]; then while read -r k v; do \
case $k in max) echo "mem_max_events=$v" ;; oom_kill) echo "oom_kills=$v" ;; esac; \
done < ${cg}/memory.events; fi
if [ -r ${cg}/cpu.stat ]; then echo "cpu_usec=$(awk '/^usage_usec/{print $2}' ${cg}/cpu.stat)"; \
elif [ -r ${cg}/cpuacct/cpuacct.usage ]; then echo "cpu_nsec=$(cat ${cg}/cpuacct/cpuacct.usage)"; \
else echo "cpu_usec=na"; fi
`
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

// Turn what usageReadCommand printed into a single human-readable usage line.
// Pure so it can be unit-tested independently of the in-cluster exec. The line
// starts "peak memory: <peak> / <limit> limit": workflow-dashboard reads the
// two from there. That peak is the memory held where the sampler ran, and the
// cgroup's own, page cache and all, only where it did not:
//
//   peak memory: 6.5Gi / 60Gi limit (11%) held, page cache left out | working
//   set peak: 23.5Gi | with the page cache: 60Gi, the limit reached 312 times,
//   0 OOM kills | cpu: 2130s total
export function formatResourceUsageReport(raw: string): string {
  const fields: { [k: string]: string } = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) {
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  const count = (key: string): number | undefined =>
    fields[key] !== undefined && /^\d+$/.test(fields[key])
      ? Number(fields[key])
      : undefined

  const cgroupPeak = count('mem_peak')
  const heldPeak = count('held_peak')
  const wsPeak = count('ws_peak')
  // cgroup v1 reports an unlimited memory limit as a huge sentinel; treat
  // anything implausibly large (or the v2 literal "max") as "no limit".
  const memLimit = count('mem_limit')
  const hasLimit = memLimit !== undefined && memLimit < 1024 ** 5 // < 1Pi

  const against = (peak: number): string =>
    hasLimit
      ? `${formatBytes(peak)} / ${formatBytes(memLimit)} limit (${Math.round((peak / memLimit) * 100)}%)`
      : `${formatBytes(peak)} (no limit)`

  // How the cgroup met its limit: each `max` event is the kernel reclaiming
  // (the page cache first) to stay under it, each OOM kill a process lost.
  const events: string[] = []
  const maxEvents = count('mem_max_events')
  const oomKills = count('oom_kills')
  if (maxEvents) {
    events.push(`the limit reached ${maxEvents} times`)
  }
  if (oomKills !== undefined) {
    events.push(`${oomKills} OOM kill${oomKills === 1 ? '' : 's'}`)
  }

  const parts: string[] = []
  if (heldPeak !== undefined) {
    parts.push(`peak memory: ${against(heldPeak)} held, page cache left out`)
    if (wsPeak !== undefined) {
      parts.push(`working set peak: ${formatBytes(wsPeak)}`)
    }
    if (cgroupPeak !== undefined) {
      parts.push(
        [`with the page cache: ${formatBytes(cgroupPeak)}`, ...events].join(
          ', '
        )
      )
    } else if (events.length) {
      parts.push(events.join(', '))
    }
  } else if (cgroupPeak !== undefined) {
    parts.push(
      [
        `peak memory: ${against(cgroupPeak)} page cache included`,
        ...events
      ].join(', ')
    )
  } else {
    parts.push('peak memory: n/a (no cgroup peak counter on this kernel)')
  }

  const cpuSec =
    fields['cpu_usec'] && fields['cpu_usec'] !== 'na'
      ? Number(fields['cpu_usec']) / 1e6
      : fields['cpu_nsec']
        ? Number(fields['cpu_nsec']) / 1e9
        : NaN
  if (Number.isFinite(cpuSec)) {
    parts.push(`cpu: ${Math.round(cpuSec * 10) / 10}s total`)
  }

  return parts.join(' | ')
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
export const ENV_NODE_PIN_LABEL_PREFIX = 'ACTIONS_RUNNER_NODE_PIN_LABEL_PREFIX'
export const DEFAULT_NODE_PIN_LABEL_PREFIX = 'ci:node:'
// Workflow-facing env key (set in the workflow's `container.env`, like
// K8S_JOB_RESOURCES). Carries the node name resolved from the PR label by the
// workflow itself, where the event payload is always available — the hook
// process gets neither GITHUB_EVENT_PATH nor the event file at prepare time.
export const NODE_PIN_ENV_KEY = 'K8S_JOB_NODE'

// Primary node-pin source: the K8S_JOB_NODE container env var, resolved by the
// workflow from the `ci:node:<nodename>` PR label. Gated by the same RunnerSet
// flag as the event-file fallback.
export function getNodePinFromEnvList(
  env?: k8s.V1EnvVar[]
): string | undefined {
  if (process.env[ENV_NODE_PIN_FROM_PR_LABEL] !== 'true') {
    return undefined
  }
  const node = env?.find(e => e.name === NODE_PIN_ENV_KEY)?.value?.trim()
  return node || undefined
}

// Locate the PR event payload on the runner. GITHUB_EVENT_PATH is not reliably
// exported to the container hook (it comes through unset even when
// GITHUB_EVENT_NAME is set), so fall back to the runner's well-known location
// under RUNNER_TEMP (which the hook does receive): $RUNNER_TEMP/_github_workflow/
// event.json, scanning the dir for any *.json if the default name differs.
function resolvePrEventPath(): string | undefined {
  const fromEnv = process.env['GITHUB_EVENT_PATH']
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv
  }
  const runnerTemp = process.env['RUNNER_TEMP']
  if (runnerTemp) {
    const dir = `${runnerTemp}/_github_workflow`
    const candidate = `${dir}/event.json`
    if (fs.existsSync(candidate)) {
      return candidate
    }
    try {
      const json = fs.readdirSync(dir).find(n => n.endsWith('.json'))
      if (json) {
        return `${dir}/${json}`
      }
    } catch {
      // directory missing — nothing to resolve
    }
  }
  return undefined
}

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
  const prefix =
    process.env[ENV_NODE_PIN_LABEL_PREFIX] || DEFAULT_NODE_PIN_LABEL_PREFIX

  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    core.debug(
      `[node-pin] event='${eventName ?? '(unset)'}' is not a pull_request; skipping`
    )
    return undefined
  }

  const eventPath = resolvePrEventPath()
  core.debug(
    `[node-pin] enabled; event='${eventName}' eventPath='${eventPath ?? '(not found)'}' prefix='${prefix}'`
  )
  if (!eventPath) {
    core.debug(
      `[node-pin] could not locate the PR event payload (GITHUB_EVENT_PATH unset, RUNNER_TEMP='${process.env['RUNNER_TEMP'] ?? '(unset)'}')`
    )
    return undefined
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    const labels = payload?.pull_request?.labels
    if (!Array.isArray(labels)) {
      core.debug(`[node-pin] no pull_request.labels array in event payload`)
      return undefined
    }
    const names = labels
      .map((l: { name?: string }) => l?.name)
      .filter((n: unknown): n is string => typeof n === 'string')
    core.debug(`[node-pin] PR labels: ${names.join(', ') || '(none)'}`)

    const matches = names.filter(n => n.startsWith(prefix))
    if (!matches.length) {
      core.debug(`[node-pin] no label with prefix '${prefix}'`)
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
  return `cd ${shlex.quote(dir)} && find . -type f -not -path '*/_runner_hook_responses*' -exec stat -c '%s %n' {} \\;`
}

// Shell script that folds the runner's _temp, staged in the pod at `src`, into
// the pod's _temp at `dst` before a script step runs.
//
// _runner_file_commands is REPLACED rather than merged. The runner creates a
// fresh set of file-command files for every step and only reads back the
// current step's set, but the hook copies the whole directory back after each
// step. Merging made it grow by ~7 files per step — and, on a persistent work
// volume, by every step of every earlier job that used the volume — so each
// step round-tripped thousands of stale files through the API server, costing
// tens of seconds to minutes per step.
//
// The rest of _temp is copied with a single `cp -a` instead of forking a shell,
// mkdir and cp for every file.
export function mergeTempDirCommand(src: string, dst: string): string {
  const s = shlex.quote(src)
  const d = shlex.quote(dst)
  return [
    'set -e',
    // The source side may be missing when the tar-based copy drops an empty
    // directory (e.g. the first step of a job).
    `mkdir -p ${s}/_runner_file_commands ${d}`,
    `rm -rf ${d}/_runner_file_commands`,
    `mv ${s}/_runner_file_commands ${d}/_runner_file_commands`,
    `cp -a ${s}/. ${d}/`,
    `rm -rf ${s}`
  ].join('\n')
}

// Shell script that removes the hook's _temp staging dirs under `workDir`. On
// a persistent work volume they still hold what earlier jobs left behind
// (file-command files, step scripts, hook responses); a new job needs none of
// it, as the runner's own _temp is copied in right afterwards. Prints how many
// files were dropped so the effect shows up in the job log.
export function clearStaleTempCommand(workDir: string): string {
  const temp = shlex.quote(`${workDir}/_temp`)
  const tempPre = shlex.quote(`${workDir}/_temp_pre`)
  return [
    `if [ -e ${temp} ] || [ -e ${tempPre} ]; then`,
    `  n=$(find ${temp} ${tempPre} -type f 2>/dev/null | wc -l | tr -d ' ')`,
    `  rm -rf ${temp} ${tempPre}`,
    `  echo "Removed $n stale file(s) left in ${workDir}/_temp by earlier jobs"`,
    'fi'
  ].join('\n')
}

// In-memory sink for an exec's stderr. Replaces stream-buffers, whose
// WritableStreamBuffer still allocates with the deprecated `new Buffer()` and
// so put a DEP0005 warning into every step's log.
export function createStringSink(): {
  stream: stream.Writable
  size: () => number
  contents: () => string
} {
  const chunks: Buffer[] = []
  return {
    stream: new stream.Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        cb()
      }
    }),
    size: () => chunks.reduce((n, c) => n + c.length, 0),
    contents: () => Buffer.concat(chunks).toString('utf8')
  }
}

// Exit code of a command run through the pod exec API, taken from its final
// V1Status (details.causes: [{ reason: 'ExitCode', message: '<n>' }]).
// Undefined when the exec failed for another reason, e.g. the pod is gone.
export function execStatusExitCode(status?: k8s.V1Status): number | undefined {
  const cause = status?.details?.causes?.find(c => c.reason === 'ExitCode')
  const code = Number(cause?.message)
  return Number.isInteger(code) && code > 0 ? code : undefined
}

// execPodStep errors carry the command's exit code when the command itself
// ran and failed, so callers can tell a failing step from an infrastructure
// failure. A plain property rather than an Error subclass: the ES5 build
// breaks instanceof for subclasses of Error.
export function withExitCode(err: Error, exitCode?: number): Error {
  if (exitCode !== undefined) {
    ;(err as Error & { exitCode?: number }).exitCode = exitCode
  }
  return err
}

export function exitCodeOf(err: unknown): number | undefined {
  const code = (err as { exitCode?: unknown } | undefined)?.exitCode
  return typeof code === 'number' ? code : undefined
}

// Copying step files to and from the job pod normally takes well under a
// second; above this it is worth telling the user where the time went.
export const SLOW_SYNC_SECONDS = 5

// User-facing note for a step whose file sync with the job pod was slow, so
// infrastructure overhead isn't mistaken for the step itself being slow.
export function slowSyncNotice(
  beforeSeconds: number,
  afterSeconds: number
): string | undefined {
  const total = beforeSeconds + afterSeconds
  if (total < SLOW_SYNC_SECONDS) {
    return undefined
  }
  return (
    `Note: the runner spent ${total.toFixed(1)}s moving step files to and from ` +
    `the job pod (${beforeSeconds.toFixed(1)}s before, ${afterSeconds.toFixed(1)}s after the step). ` +
    `This is infrastructure overhead, not time spent in your step.`
  )
}

// User-facing hint for step exit codes whose cause isn't obvious from the
// step's own output.
export function exitCodeHint(exitCode: number): string | undefined {
  if (exitCode === 137) {
    return (
      'Exit code 137: the process was killed (SIGKILL). In a Kubernetes job pod ' +
      'this is most often the out-of-memory killer; the job container memory ' +
      'limit is shown under "Initialize containers".'
    )
  }
  return undefined
}

// Safely turn an unknown thrown value into a diagnostic string without
// throwing. The previous `JSON.stringify(err)` pattern crashed with
// `TypeError: Converting circular structure to JSON` when err was a
// @kubernetes/client-node HTTP error (its response embeds a
// TLSSocket <-> HTTPParser cycle). The thrown TypeError shadowed the
// original failure in every catch block that used it (issue #329).
export function formatError(err: unknown): string {
  if (err === null || err === undefined) {
    return String(err)
  }

  // @kubernetes/client-node API errors expose the actual server message
  // under response.body — prefer that when available.
  const body =
    (err as { response?: { body?: unknown } })?.response?.body ??
    (err as { body?: unknown })?.body
  if (body && typeof body === 'object') {
    const msg = (body as { message?: unknown }).message
    const reason = (body as { reason?: unknown }).reason
    if (typeof msg === 'string') {
      return typeof reason === 'string' && reason.length > 0
        ? `${msg} (reason: ${reason})`
        : msg
    }
  }

  if (err instanceof Error) {
    return err.message
  }

  if (typeof err === 'object') {
    // Non-Error objects sometimes carry a top-level message (axios-style
    // errors, hand-rolled error-likes). Extract before the JSON.stringify
    // branch so a circular ref doesn't reduce the diagnostic to
    // "[object Object]".
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') {
      return msg
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }

  // Primitives serialise more readably via String() than JSON.stringify
  // (which would quote strings and refuse to handle symbols).
  return String(err)
}
