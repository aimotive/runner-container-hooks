#!/usr/bin/env bash
# The runner's job-started hook: point ACTIONS_RUNNER_HOOK_JOB_STARTED at this file
# (the runner image does) and every job's "Set up runner" step says which node its
# runner pod runs on —
#
#   Runner pod <pod> is running on node <node>
#
# — with a container or without. A job without one runs its steps in the runner
# pod, whose node nothing else records. It asks the Kubernetes API for the runner
# pod (ACTIONS_RUNNER_POD_NAME) with the pod's own service account, through the
# k8s-novolume hook bundle beside this file. Best-effort: never fails the job.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin=""
for candidate in "${here}/../externals/node20/bin/node" "${here}/../externals/node24/bin/node"; do
  if [ -x "${candidate}" ]; then
    node_bin="${candidate}"
    break
  fi
done
node_bin="${node_bin:-$(command -v node || true)}"
if [ -n "${node_bin}" ] && [ -f "${here}/index.js" ]; then
  "${node_bin}" "${here}/index.js" job-started || true
fi
exit 0
