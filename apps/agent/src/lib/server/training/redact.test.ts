// @vitest-environment node
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRedactionRoots, redact, redactArguments, REDACTION_PLACEHOLDERS as P } from "./redact";

// Fake credentials are assembled at run time so no secret-shaped literal lives in the repository.
const chars = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY";
const fake = (prefix: string, length: number, alphabet = chars) =>
  prefix + Array.from({ length }, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join("");
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const roots = ["D:\\data\\workspace", "D:\\data", "/srv/tatvam/data"];
const secrets = (text: string) => redact(text, { pii: false, roots });
const all = (text: string) => redact(text, { pii: true, roots });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("redact: secrets", () => {
  const cases: [string, string, string, keyof typeof P][] = [
    ["OpenAI key", fake("sk-", 48), P.api_key, "api_key"],
    ["OpenAI project key", fake("sk-proj-", 40), P.api_key, "api_key"],
    ["GitHub classic token", fake("ghp_", 36), P.github_token, "github_token"],
    ["GitHub OAuth token", fake("gho_", 36), P.github_token, "github_token"],
    ["GitHub user token", fake("ghu_", 36), P.github_token, "github_token"],
    ["GitHub server token", fake("ghs_", 36), P.github_token, "github_token"],
    ["GitHub fine-grained token", fake("github_pat_", 60), P.github_token, "github_token"],
    ["AWS access key", fake("AKIA", 16, UPPER), P.aws_key, "aws_key"],
    ["Slack bot token", fake("xoxb-", 40), P.slack_token, "slack_token"],
    ["Hugging Face token", fake("hf_", 34), P.hf_token, "hf_token"],
    ["Google API key", fake("AIza", 35), P.google_api_key, "google_api_key"],
    ["JWT", `${fake("eyJ", 20)}.${fake("eyJ", 30)}.${fake("", 43)}`, P.jwt, "jwt"],
  ];

  it.each(cases)("masks a %s", (_label, value, placeholder, kind) => {
    const result = secrets(`use ${value} here`);
    expect(result.text).toBe(`use ${placeholder} here`);
    expect(result.counts).toEqual({ [kind]: 1 });
  });

  it("masks PEM private key blocks, including JSON-escaped and truncated ones", () => {
    const body = fake("", 64);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(secrets(`key:\n${pem}\ndone`).text).toBe(`key:\n${P.private_key}\ndone`);
    const escaped = pem.replace(/\n/g, "\\n");
    expect(secrets(`{"key":"${escaped}"}`).text).toBe(`{"key":"${P.private_key}"}`);
    expect(secrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`).text).toBe(P.private_key);
    expect(secrets("-----BEGIN PUBLIC KEY-----").text).toBe("-----BEGIN PUBLIC KEY-----");
  });

  it("keeps the Authorization header name and scheme but masks the value", () => {
    const token = fake("", 32);
    expect(secrets(`Authorization: Bearer ${token}`).text).toBe(`Authorization: Bearer ${P.bearer_token}`);
    expect(secrets(`curl -H "authorization: Basic ${token}=="`).text).toBe(`curl -H "authorization: Basic ${P.bearer_token}"`);
    expect(secrets(`{"Authorization": "Token ${token}"}`).text).toBe(`{"Authorization": "Token ${P.bearer_token}"}`);
    expect(secrets(`send Bearer ${token} upstream`).text).toBe(`send Bearer ${P.bearer_token} upstream`);
    expect(secrets(`Authorization: Bearer ${token}`).counts).toEqual({ bearer_token: 1 });
  });

  it("masks password, secret, token and API key assignments but keeps the key name", () => {
    const cases: [string, string][] = [
      ["password=hunter2", `password=${P.secret}`],
      ["DB_PASSWORD=postgres", `DB_PASSWORD=${P.secret}`],
      ["export API_KEY=abc123def", `export API_KEY=${P.secret}`],
      ['"api_key": "abc123"', `"api_key": "${P.secret}"`],
      ["{'client_secret': 'xyz-789'}", `{'client_secret': '${P.secret}'}`],
      ["client_secret: s3cr3t-value", `client_secret: ${P.secret}`],
      ["apiKey = 'abcdef123'", `apiKey = '${P.secret}'`],
      ["x-api-key: k_29f8a7", `x-api-key: ${P.secret}`],
      ["GET /cb?access_token=abc123&state=1", `GET /cb?access_token=${P.secret}&state=1`],
      ["--password=letmein", `--password=${P.secret}`],
      ["passwd := 'pa ss'", `passwd := '${P.secret}'`],
      ["SECRET_KEY=django-insecure-x", `SECRET_KEY=${P.secret}`],
      ["The password: hunter2.", `The password: ${P.secret}.`],
      ["//registry.npmjs.org/:_authToken=abc123", `//registry.npmjs.org/:_authToken=${P.secret}`],
      ['private String password = "x1";', `private String password = "${P.secret}";`],
    ];
    for (const [input, expected] of cases) expect(secrets(input).text, input).toBe(expected);
    expect(secrets("password=hunter2 token=abc123").counts).toEqual({ secret: 2 });
  });

  it("masks credentials in URLs", () => {
    expect(secrets("clone https://alice:p4ss@git.example.com/repo.git").text).toBe(
      `clone https://${P.url_credentials}@git.example.com/repo.git`,
    );
    expect(secrets("DATABASE_URL=postgres://admin:pw@db:5432/app").text).toBe(
      `DATABASE_URL=postgres://${P.url_credentials}@db:5432/app`,
    );
    expect(secrets("https://alice:p4ss@example.com").counts).toEqual({ url_credentials: 1 });
  });

  it("counts each value once when one secret sits inside another pattern", () => {
    const token = fake("ghp_", 36);
    expect(secrets(`GITHUB_TOKEN=${token}`)).toEqual({ text: `GITHUB_TOKEN=${P.github_token}`, counts: { github_token: 1 } });
    expect(secrets(`https://user:${token}@github.com`).counts).toEqual({ url_credentials: 1 });
    const jwt = `${fake("eyJ", 20)}.${fake("eyJ", 30)}.${fake("", 43)}`;
    expect(secrets(`Authorization: Bearer ${jwt}`)).toEqual({ text: `Authorization: Bearer ${P.jwt}`, counts: { jwt: 1 } });
  });

  it("leaves ordinary code alone", () => {
    const code = [
      "const token = getToken();",
      "const password = process.env.DB_PASSWORD;",
      "password: string;",
      "password?: string;",
      "token: z.string().min(1),",
      'if (token === "") return;',
      "if (password == null) throw new Error('missing');",
      "max_tokens = 1024",
      "max_tokens: 8192,",
      'tokenizer = AutoTokenizer.from_pretrained("gpt2")',
      "def check(password=None):",
      'api_key=os.environ["OPENAI_API_KEY"]',
      "token=token, password=userPassword",
      "const clean = token => token.trim();",
      "headers: { Authorization: `Bearer ${token}` }",
      'headers = {"Authorization": f"Bearer {token}"}',
      "secret: ${{ secrets.DEPLOY_KEY }}",
      "password: <your password>",
      'password = ""',
      "The token: expired yesterday.",
      "token_count: 42",
      "Use the API key from settings.",
      "Authorization = authHeader",
      "class Token: pass",
      "sk-learn and task-runner and sk-skeleton-loader-container",
      "hf_hub_download(repo_id)",
      'token := os.Getenv("TOKEN")',
      'let api_key: String = env::var("API_KEY")?;',
      "TOKEN=$(cat token.txt)",
      'print(f"token={token}")',
      "secret_santa = True",
      "passwordInput.value = input",
      '<input type="password" name="password" />',
    ].join("\n");
    expect(secrets(code)).toEqual({ text: code, counts: {} });
  });

  it("is idempotent", () => {
    const input = `password=hunter2 ${fake("sk-", 48)} Authorization: Bearer ${fake("", 32)} https://a:b@h.io alice@example.com +1 555 123 4567`;
    const once = all(input);
    expect(Object.keys(once.counts).length).toBeGreaterThan(3);
    expect(all(once.text)).toEqual({ text: once.text, counts: {} });
  });
});

describe("redact: personal data", () => {
  it("masks emails, phone numbers and IP addresses only when asked", () => {
    const text = "Mail alice.smith+dev@example.co.uk or call +1 (555) 123-4567 from 203.0.113.7";
    expect(secrets(text)).toEqual({ text, counts: {} });
    expect(all(text)).toEqual({
      text: `Mail ${P.email} or call ${P.phone} from ${P.ip_address}`,
      counts: { email: 1, phone: 1, ip_address: 1 },
    });
  });

  it("masks common phone formats", () => {
    for (const phone of ["+44 20 7946 0958", "+91 98765 43210", "+919876543210", "(555) 123-4567", "555-123-4567", "555.123.4567"])
      expect(all(`call ${phone} now`).text, phone).toBe(`call ${P.phone} now`);
  });

  it("masks private and public IPv4 and IPv6 addresses", () => {
    expect(all("ssh deploy@10.0.0.5 -p 22").text).toBe(`ssh deploy@${P.ip_address} -p 22`);
    expect(all("http://192.168.1.20:8080/health").text).toBe(`http://${P.ip_address}:8080/health`);
    expect(all("listen on 2001:db8:85a3::8a2e:370:7334 now").text).toBe(`listen on ${P.ip_address} now`);
    expect(all("[2001:db8::1]:443").text).toBe(`[${P.ip_address}]:443`);
  });

  it("does not mask version strings, ordinary numbers, hex values or code", () => {
    const text = [
      "v1.2.3 and 1.2.3 and react@18.3.1 and Node 24.15.0 and Windows 10.0.26200",
      "Python 3.12.1, numpy==1.26.4, ^4.6.5, ~2.0",
      "commit 6513362 and e3b0c44298fc1c149afbf4c8996fb92427ae41e4, 0xdeadbeef, #ff00aa, abc1234",
      "1234567890 items, port 3000, 2026-10-10, 12:30:45, 2026-10-10T12:00:00.000Z",
      "x[1::2], std::vector, a::before, aa:bb:cc:dd:ee:ff",
      "127.0.0.1, 0.0.0.0, 255.255.255.0, localhost:3000, ::1, fe80::1",
      "logo@2x.png, git@github.com:org/repo.git, @types/node, user@1.2.3",
      "total = a + 1234 * 5678; id: 12345678",
      "123e4567-e89b-12d3-a456-426614174000 00000000-0000-0000-0000-000000000000 user@localhost",
    ].join("\n");
    expect(all(text)).toEqual({ text, counts: {} });
  });
});

describe("redact: paths", () => {
  it("rewrites Windows, escaped, forward-slash, MSYS and POSIX paths under the roots to /workspace", () => {
    const cases: [string, string][] = [
      ["D:\\data\\workspace\\src\\app.ts:12:5", "/workspace/src/app.ts:12:5"],
      ["d:/data/workspace/src/app.ts", "/workspace/src/app.ts"],
      ['"D:\\\\data\\\\workspace\\\\src\\\\a.ts"', '"/workspace/src/a.ts"'],
      ["/d/data/workspace/README.md", "/workspace/README.md"],
      ["D:\\data\\worktrees\\abc\\x.ts", "/workspace/worktrees/abc/x.ts"],
      ["cd D:\\data\\workspace\\", "cd /workspace/"],
      ["(/srv/tatvam/data/tatvam.db)", "(/workspace/tatvam.db)"],
      ["at D:\\data", "at /workspace"],
    ];
    for (const [input, expected] of cases) expect(secrets(input).text, input).toBe(expected);
    expect(secrets("D:\\data\\workspace\\a.ts and D:/data/b.ts").counts).toEqual({ path: 2 });
  });

  it("leaves other paths and lookalike prefixes alone", () => {
    const text = "D:\\other\\file.ts D:\\data2\\x /srv/tatvam/database/x /workspace/src/app.ts /home/srv/tatvam/data/x src/data/x";
    expect(secrets(text)).toEqual({ text, counts: {} });
  });

  it("uses the workspace and data folders by default", () => {
    const dir = path.resolve("tmp-redact-root");
    vi.stubEnv("DATA_DIR", dir);
    vi.stubEnv("WORKSPACE_DIR", "");
    expect(defaultRedactionRoots()).toEqual([path.join(dir, "workspace"), dir]);
    const result = redact(`open ${path.join(dir, "workspace", "src", "a.ts")} and ${path.join(dir, "tatvam.db")}`, { pii: false });
    expect(result).toEqual({ text: "open /workspace/src/a.ts and /workspace/tatvam.db", counts: { path: 2 } });
  });
});

describe("redactArguments", () => {
  it("redacts JSON values one by one and masks values under secret-like keys", () => {
    const raw = JSON.stringify({
      path: "D:\\data\\workspace\\.env",
      content: "API_KEY=abc123def\nDEBUG=true\n",
      password: "hunter2",
      nested: [{ token: "plain" }, { note: fake("ghp_", 36) }],
      max_tokens: 100,
    });
    const result = redactArguments(raw, { pii: false, roots });
    expect(JSON.parse(result.text)).toEqual({
      path: "/workspace/.env",
      content: `API_KEY=${P.secret}\nDEBUG=true\n`,
      password: P.secret,
      nested: [{ token: P.secret }, { note: P.github_token }],
      max_tokens: 100,
    });
    expect(result.counts).toEqual({ path: 1, secret: 3, github_token: 1 });
  });

  it("returns unchanged arguments exactly and falls back to text for invalid JSON", () => {
    const raw = '{ "path": "src/app.ts",  "start": 1 }';
    expect(redactArguments(raw, { pii: false, roots })).toEqual({ text: raw, counts: {} });
    expect(redactArguments('{"password": "hunter2"', { pii: false, roots }).text).toBe(`{"password": "${P.secret}"`);
    expect(redactArguments('"a string"', { pii: true, roots })).toEqual({ text: '"a string"', counts: {} });
  });
});
