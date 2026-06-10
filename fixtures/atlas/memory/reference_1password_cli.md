---
name: 1Password CLI (op) access
description: 1Password CLI is available and authenticated to both personal and CopilotKit org vaults — use for secrets management
type: reference
originSessionId: e654541f-dcb7-4152-8ee8-f669848555ee
---
1Password CLI (`op`) v2.32+ is installed and authenticated.

**Accounts:**
- Personal: `my.1password.com` (jpr5@darkridge.com)
- CopilotKit org: `copilotkit.1password.com` (jordan@copilotkit.ai), account ID `7VMI7XKGNZB25JUN6TOENCY45I`

**Usage:**
- `OP_BIOMETRIC_UNLOCK_ENABLED=true` is already exported in the user's shell — do NOT prefix it on op commands (causes redundant biometric prompts)
- CopilotKit org requires `--account 7VMI7XKGNZB25JUN6TOENCY45I` flag
- Use `op item get <id> --account <acct> --format=json` to read entries
