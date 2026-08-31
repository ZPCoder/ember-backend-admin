# Operator console

This dependency-free static console consumes only `/v1/admin/*`. Serve it behind the organisation identity proxy; the proxy must implement `AdminAuthenticator` and must never trust browser-supplied administrator IDs or role headers.

Every POST invokes a typed confirmation phrase, and the service checks it again before the transaction. The first vertical slice covers player lookup, Flutter migration preview/apply/rollback, audit history, PVP replay, and current config version.
