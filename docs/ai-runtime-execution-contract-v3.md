# AI runtime execution contract v3

Status: current successor contract. This document supersedes the reviewed-deployment, runtime-build-ID and binding-manifest admission model described by `ai-runtime-execution-contract-v2.md`. The frozen v1 documents `ai-provider-contract.md` and `ai-runtime-execution-contract.md` remain unchanged historical evidence.

The database freezes the selected profile, price, policy, legal bundle and runtime-contract IDs before transmission. A v2 profile version fixes its endpoint URL, credential environment-variable name, model ID and adapter configuration. Retries consume the same snapshot and never resolve a current routing pointer again.

Compiled code determines the adapter implementations and Provider security rules. A v2 credential name must match `^AI_PROVIDER_KEY_[A-Z0-9_]+$`, then match the selected Provider's approved prefix. The resolver reads only a filtered Provider-secret map. The selected endpoint must have an HTTPS official origin allowed for that Provider and the adapter/wire path must be supported; redirects, private/IP destinations and arbitrary endpoint origins fail closed. This prevents a database configuration from selecting unrelated server secrets or sending a Provider credential to another recipient.

There is no manually registered per-build admission. Validation reports and readbacks record the current Admin environment/project. A build may emit its embedded source commit to a safe startup diagnostic log; that optional observation is neither a report field nor authority for a configuration. The binding authority remains the frozen DB target plus compiled adapter/capability, credential-prefix and origin rules.

Before a v2 transmission, the runtime strictly decodes the snapshot, checks adapter capability and runtime/legal/price bindings, resolves the Provider-limited credential and destination, obtains the existing request/attempt authority, then prepares transport. Any failed check sends no content and follows the existing no-transmission settlement path. There is no cross-provider fallback.

Safe analytics and Admin projections never expose credentials, credential names, endpoint URLs, raw upstream identifiers, CV content, prompts or responses. Attempts may retain automatic diagnostic provenance, model and endpoint observations only under the established exact-match and redaction rules.
