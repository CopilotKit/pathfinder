---
name: agentcore-cli upstream PR preparation
description: Prepare but do NOT submit an upstream PR to aws/agentcore-cli fixing remaining pull_request_target patterns in codeql.yml and pr-size.yml
type: project
originSessionId: 44594a2f-f7ca-46fb-9eb9-d25cbf63813b
---
agentcore-cli is a fork of aws/agentcore-cli. We've already fixed the dangerous pull_request_target patterns in our fork:
- e2e-tests.yml: redesigned to workflow_dispatch only
- pr-tarball.yml: split into build (pull_request) + publish (workflow_run)

**Action:** Prepare an upstream PR to aws/agentcore-cli with our fixes. DO NOT submit until explicitly approved by user.
