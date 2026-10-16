# K8s Hooks

## Description
This implementation provides a way to dynamically spin up jobs to run container workflows, rather then relying on the default docker implementation. It is meant to be used when the runner itself is running in k8s, for example when using the [Actions Runner Controller](https://github.com/actions-runner-controller/actions-runner-controller)

## Pre-requisites 
Some things are expected to be set when using these hooks
- The runner itself should be running in a pod, with a service account with the following permissions
```
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: runner-role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "create", "delete"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["get", "create"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list", "watch",]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "delete"]
```
- The `ACTIONS_RUNNER_POD_NAME` env should be set to the name of the pod
- The `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` env should be set to true to prevent the runner from running any jobs outside of a container
- The runner pod should map a persistent volume claim into the `_work` directory
    - The `ACTIONS_RUNNER_CLAIM_NAME` env should be set to the persistent volume claim that contains the runner's working directory, otherwise it defaults to `${ACTIONS_RUNNER_POD_NAME}-work`
- Some actions runner env's are expected to be set. These are set automatically by the runner.
    - `RUNNER_WORKSPACE` is expected to be set to the workspace of the runner
    - `GITHUB_WORKSPACE` is expected to be set to the workspace of the job


## Where a job runs

GitHub only knows a runner by its pod's name, and a runner pod is not told its own node. The hooks say both pods' nodes in the job's log, in lines a reader (or a dashboard) can rely on:

```
Runner pod <runner pod> is running on node <node>
Job pod <runner pod>-workflow is running on node <node>
```

- "Initialize containers" (`prepare_job`) prints both, for a job with a container.
- A job without a container runs its steps in the runner pod, and no hook runs for it. `job-started.sh`, set as the runner's job-started hook, covers it: `ACTIONS_RUNNER_HOOK_JOB_STARTED=<dir>/job-started.sh`, with the bundle's `index.js` beside it. Every job's "Set up runner" step then prints the runner pod's line. It runs `index.js job-started`, which reads the runner pod (`ACTIONS_RUNNER_POD_NAME`) with the pod's own service account — the `get pods` the hooks already need — and never fails the job.

## Limitations
- A [job containers](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container) will be required for all jobs
- Building container actions from a dockerfile is not supported at this time
- Container actions will not have access to the services network or job container network
- Docker [create options](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontaineroptions) are not supported
- Container actions will have to specify the entrypoint, since the default entrypoint will be overridden to run the commands from the workflow.
- Container actions need to have the following binaries in their container image: `sh`, `env`, `tail`.
