// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load, loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

// Static checks on the deployment files, since no cluster or Docker is available in CI by default.

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const root = path.resolve("deploy");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function yamlFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(relative);
    return /\.ya?ml$/.test(entry.name) ? [relative] : [];
  });
}

const base = ["namespace.yaml", "tatvam.yaml", "vllm.yaml", "network-policies.yaml"].flatMap(
  (file) => loadAll(read(`k8s/base/${file}`)) as Doc[],
);
const byKind = (kind: string, name: string) => base.find((doc) => doc.kind === kind && doc.metadata?.name === name)!;
const containers = base.filter((doc) => doc.kind === "Deployment").flatMap((doc) => doc.spec.template.spec.containers as Doc[]);

describe("Kubernetes manifests", () => {
  it("all parse as YAML", () => {
    for (const file of yamlFiles("k8s")) expect(() => loadAll(read(file)), file).not.toThrow();
  });

  it("keep the example secret out of the kustomization", () => {
    const kustomization = load(read("k8s/base/kustomization.yaml")) as Doc;
    expect(kustomization.resources).not.toContain("secret.example.yaml");
    for (const doc of base) expect(doc.kind).not.toBe("Secret");
  });

  it("harden every container", () => {
    for (const container of containers) {
      expect(container.securityContext.allowPrivilegeEscalation, container.name).toBe(false);
      expect(container.securityContext.capabilities.drop, container.name).toEqual(["ALL"]);
      expect(String(container.image), container.name).not.toMatch(/:latest$/);
      for (const env of (container.env ?? []) as Doc[])
        if (env.valueFrom?.secretKeyRef) expect(env.valueFrom.secretKeyRef.name).toBe("tatvam-secrets");
    }
  });

  it("run the agent as a single non-root replica with a read-only root and health probes", () => {
    const deployment = byKind("Deployment", "tatvam");
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy.type).toBe("Recreate");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.readinessProbe.httpGet.path).toBe("/api/health");
    const config = byKind("ConfigMap", "tatvam-config");
    expect(config.data.COMMAND_RUNNER).toBe("off");
  });

  it("let only the agent reach vLLM and deny everything by default", () => {
    expect(byKind("NetworkPolicy", "default-deny").spec.podSelector).toEqual({});
    const vllm = byKind("NetworkPolicy", "vllm");
    expect(vllm.spec.ingress).toEqual([
      { from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "tatvam" } } }], ports: [{ port: 8000 }] },
    ]);
    const egress = byKind("NetworkPolicy", "tatvam").spec.egress as Doc[];
    const internet = egress.find((rule) => rule.to?.[0]?.ipBlock)!;
    expect(internet.to[0].ipBlock.except).toEqual(expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16"]));
  });

  it("set the public host in both overlays", () => {
    for (const overlay of ["ingress", "openshift"]) {
      const kustomization = load(read(`k8s/overlays/${overlay}/kustomization.yaml`)) as Doc;
      expect(kustomization.resources).toContain("../../base");
      expect(JSON.stringify(kustomization.patches)).toContain("ALLOWED_HOSTS");
    }
    const route = load(read("k8s/overlays/openshift/route.yaml")) as Doc;
    expect(route.spec.tls).toMatchObject({ termination: "edge", insecureEdgeTerminationPolicy: "Redirect" });
  });
});

describe("compose file", () => {
  const compose = load(read("compose/compose.gpu.yaml")) as Doc;

  it("publishes the UI on loopback only and never publishes vLLM", () => {
    expect(compose.services.tatvam.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(compose.services.vllm.ports).toBeUndefined();
  });

  it("hardens the agent container and requires pinned model images", () => {
    expect(compose.services.tatvam.read_only).toBe(true);
    expect(compose.services.tatvam.cap_drop).toEqual(["ALL"]);
    expect(compose.services.vllm.image).toMatch(/^\$\{VLLM_IMAGE:\?/);
  });
});

describe("Dockerfile", () => {
  const dockerfile = readFileSync(path.resolve("Dockerfile"), "utf8");

  it("runs as a non-root user with tini and a health check", () => {
    expect(dockerfile).toMatch(/^USER 10001$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).toContain("/api/health");
    expect(dockerfile).toContain("COMMAND_RUNNER=off");
    expect(dockerfile).toContain("/app/evals ./evals");
  });
});
