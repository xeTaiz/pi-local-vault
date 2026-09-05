# Pi Local Vault

Authenticated Knowledge Vault tools for [Pi](https://github.com/badlogic/pi-mono) and Oh My Pi (OMP).

## Install

```sh
pi install git:github.com/xeTaiz/pi-local-vault
```

```sh
omp plugin install git:github.com/xeTaiz/pi-local-vault
```

Both package managers load `index.ts` through the repository's `pi.extensions` and `omp.extensions` manifests.

For pinned rollouts, run `npm pack` in the reviewed checkout and install the same
checksummed `pi-local-vault-0.1.4.tgz` artifact on every host. Restart the agent
after installation; already-running sessions retain their loaded module.
Confirm `omp plugin list` reports `pi-local-vault@0.1.4` before launching task agents.

## Configure

Set:

- `LOCAL_VAULT_URL` — appliance base URL; defaults to `http://127.0.0.1:8088`.
- `LOCAL_VAULT_TOKEN_FILE` — bearer-token file; defaults to `~/.config/pi/local-vault.token`.
- `LOCAL_VAULT_TAILNET_DNS_SUFFIX` — optional trusted MagicDNS/Headscale suffix, for example `hs.d0me.xyz`.
- `LOCAL_VAULT_READONLY=1` — omit `vault_update` and `vault_research` registration.
- `WH_SESSION_ROLE=task` — always omit both writes, even if the read-only flag is
  absent or `0`. PM, orchestrator, and ordinary sessions retain writes unless
  explicitly read-only.

The token file must contain only the client bearer token. Plain HTTP is accepted
only for loopback, Tailnet IPv4 addresses in `100.64.0.0/10`, or hostnames below
the explicitly configured Tailnet DNS suffix. Other hosts require HTTPS.

## Tools

- `vault_read` — first source for relevant prior project knowledge, decisions, research, infrastructure, discussions, and user context.
- `vault_get` — sparse full-note fetch bound to a result from `vault_read`.
- `vault_update` — submit a self-contained durable knowledge update.
- `vault_research` — research and save durable knowledge.
- `vault_job_status` — administrative update/research diagnostics for Local Vault maintenance only.

OMP loads `vault_read` and `vault_update` as essential tools. The remaining tools stay available without occupying the essential tool set.

Read-only registration retains `vault_read`, `vault_get`, and the read-only
`vault_job_status` diagnostic. This is a tool-surface restriction, not a substitute
for a service-side read-scoped token: arbitrary HTTP clients with a broader token
still possess that token's service permissions.

## Development

```sh
npm install
npm test
npm run typecheck
```
