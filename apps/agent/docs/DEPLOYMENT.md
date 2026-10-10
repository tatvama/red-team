# Deploying Tatvam Agent

Three ways to run it, from simplest to most production-like:

| Option | Use when | Files |
| --- | --- | --- |
| Local dev | Trying it out, building it | `pnpm dev` / `pnpm dev:mock` |
| Docker Compose | One GPU server, one user or a small team | `deploy/compose/` |
| Kubernetes / OpenShift | A cluster with GPU nodes | `deploy/k8s/` |

The agent is a single process with its state in `DATA_DIR` (SQLite, checkpoints, worktrees, `mcp.json`). Run **one replica** and back up the data volume.

## Access model

| Reached at | Requirement |
| --- | --- |
| `127.0.0.1` / `localhost` | Nothing. This is the single local user, including through an SSH tunnel. |
| Any other host name | It must be listed in `ALLOWED_HOSTS` **and** `ACCESS_TOKEN` must be set. Users sign in at `/login`; API clients send `Authorization: Bearer <ACCESS_TOKEN>`. |
| Anything else | Refused with 403, which also blocks DNS rebinding. |

Sessions are HMAC-signed, HttpOnly, `SameSite=Strict` cookies, and `Secure` behind HTTPS. They last 7 days. Rotating `ACCESS_TOKEN` (or `SESSION_SECRET`) signs everyone out. Failed sign-ins are rate-limited per client. Always terminate TLS in front of the app; never expose port 3000 directly.

## Docker Compose on a GPU server

Prerequisites are Docker with the NVIDIA Container Toolkit, and a driver and CUDA version supported by the vLLM image you pin.

```bash
cp deploy/compose/.env.example deploy/compose/.env   # fill it in; generate keys with: openssl rand -hex 32
docker compose -f deploy/compose/compose.gpu.yaml --env-file deploy/compose/.env build
docker compose -f deploy/compose/compose.gpu.yaml --env-file deploy/compose/.env up -d
```

- vLLM has no published port. Only the agent reaches it, over the private compose network.
- The UI is published on `127.0.0.1:3000` of the server. From your laptop, run `ssh -L 3000:127.0.0.1:3000 gpu-server` and open http://127.0.0.1:3000.
- Add `--profile search` to also run SearXNG, then set `SEARCH_PROVIDER=searxng` and `SEARXNG_URL=http://searxng:8080`. SearXNG must have the JSON format enabled in its `settings.yml`.
- The agent's root filesystem is read-only, all capabilities are dropped, and only `/data` and `/workspace` are writable.

## Kubernetes

Prerequisites are GPU nodes with the NVIDIA device plugin (or GPU operator), an ingress controller with TLS (cert-manager or your own certificate), and a CNI that enforces NetworkPolicy.

1. Build and push the image: `docker build -t registry.example.com/tatvam-agent:0.1.0 .`
2. Pin images and set the model:
   - `deploy/k8s/base/kustomization.yaml`: set `images`, giving the vLLM tag a tested version and pointing `tatvam-agent` at your registry.
   - `deploy/k8s/base/vllm.yaml`: set `VLLM_MODEL` and `VLLM_TOOL_PARSER`.
3. Create the secrets (see `deploy/k8s/base/secret.example.yaml`):
   ```bash
   kubectl create namespace tatvam
   kubectl -n tatvam create secret generic tatvam-secrets \
     --from-literal=VLLM_API_KEY="$(openssl rand -hex 32)" \
     --from-literal=ACCESS_TOKEN="$(openssl rand -hex 32)" \
     --from-literal=SESSION_SECRET="$(openssl rand -hex 32)"
   ```
4. Set your host name in `deploy/k8s/overlays/ingress/` (both files), then apply: `kubectl apply -k deploy/k8s/overlays/ingress`.

What you get:

- **NetworkPolicies:**
  - default deny
  - only the agent can call vLLM
  - the agent can reach DNS, vLLM and public HTTPS, with private ranges and the cloud metadata address excluded
- **Agent pod:**
  - non-root, read-only root filesystem, no service-account token, seccomp `RuntimeDefault`
  - `/data` and `/workspace` on PVCs, with health probes on `/api/health`
- **vLLM:**
  - one GPU, a model cache PVC, and shared memory sized for tensor parallelism
  - a startup probe that allows up to 30 minutes for the model to download and load

## OpenShift

```bash
oc apply -k deploy/k8s/overlays/openshift
```

The overlay replaces Ingress with an edge-TLS Route that redirects HTTP to HTTPS. It also removes fixed UIDs so the `restricted-v2` SCC can assign them; the image keeps all writable paths group-0 writable for that. To put OpenShift's OAuth login in front, add an `oauth-proxy` sidecar and keep `ACCESS_TOKEN` as the second factor for API clients.

## Running commands in a cluster

`COMMAND_RUNNER=docker` needs a Docker daemon, which pods don't have. In Kubernetes, either keep commands `off` (the default), or set `host`. In that case commands run inside the agent pod, so the pod is the sandbox, with its NetworkPolicy, non-root user and read-only root. The model and search keys are in that pod's environment. Commands strip them from their own environment, but a determined command running as the same user could still read them, so keep the permission mode on **Ask** and scope those keys narrowly.

## Upgrades and backups

- Database migrations run automatically at startup and are append-only.
- Back up the `tatvam-data` volume. It holds conversations, settings, memories, checkpoints and worktrees.
- To roll back the image, restore the data volume backup taken before the upgrade.
