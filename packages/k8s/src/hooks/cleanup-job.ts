import * as core from '@actions/core'
import {
  getPvcVolumeName,
  prunePods,
  pruneSecrets,
  releasePv,
  reportPeakResourceUsage
} from '../k8s'
import {
  releaseWorkVolumePvEnabled,
  reportResourceUsageEnabled
} from '../k8s/utils'
import { getJobPodName } from './constants'

export async function cleanupJob(): Promise<void> {
  // Read the job container's peak resource usage while it is still alive
  // (before prunePods tears the pod down). Best-effort, never fatal.
  if (reportResourceUsageEnabled()) {
    try {
      await reportPeakResourceUsage(getJobPodName())
    } catch (err) {
      core.debug(
        `[usage] failed to report resource usage: ${(err as Error)?.message ?? err}`
      )
    }
  }

  // If targeted PV release is enabled, resolve the PV backing this job's work
  // volume BEFORE deleting the pod (deleting it garbage-collects the ephemeral
  // PVC, after which the PV name can no longer be read from the PVC).
  let pvToRelease: string | undefined
  if (releaseWorkVolumePvEnabled()) {
    const pvcName = `${getJobPodName()}-work`
    try {
      pvToRelease = await getPvcVolumeName(pvcName)
      core.info(
        `[pv-release] Work volume: PVC=${pvcName} PV=${pvToRelease ?? '(unbound)'}`
      )
    } catch (err) {
      // PVC missing (e.g. not persistent mode) or unreadable: nothing to
      // release. Never let this block job cleanup.
      core.info(
        `[pv-release] No work-volume PV to release for PVC ${pvcName}: ${(err as Error)?.message ?? err}`
      )
    }
  }

  await Promise.all([prunePods(), pruneSecrets()])

  if (pvToRelease) {
    try {
      await releasePv(pvToRelease)
    } catch (err) {
      core.warning(
        `[pv-release] Failed to release PV ${pvToRelease}: ${(err as Error)?.message ?? err}. The reaper will reclaim it.`
      )
    }
  }
}
