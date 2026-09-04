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

## Configure

Set:

- `LOCAL_VAULT_URL` — appliance base URL; defaults to `http://127.0.0.1:8088`.
- `LOCAL_VAULT_TOKEN_FILE` — bearer-token file; defaults to `~/.config/pi/local-vault.token`.
- `LOCAL_VAULT_TAILNET_DNS_SUFFIX` — optional trusted MagicDNS/Headscale suffix, for example `hs.d0me.xyz`.

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

## Development

```sh
npm install
npm test
npm run typecheck
```
