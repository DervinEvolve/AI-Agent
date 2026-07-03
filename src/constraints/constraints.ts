export interface Constraint {
  id: string;
  name: string;
  status: 'active' | 'deprecated';
  added_epoch: number;
  description: string;
  enforcement: string;
  secret_policy: string;
  network_policy: string;
  tests: string[];
}

export const constraints: Constraint[] = [
  {
    id: "con_exec_isolation_1",
    name: "Never execute agent code outside the sandbox",
    status: "active",
    added_epoch: 1,
    description: "The agent must NEVER run generated or user-supplied code directly on the host, on shared application infrastructure, or with host credentials. All code execution goes through the sandbox with its resource limits and isolation boundary intact. The sandbox must default to no outbound network access (deny-by-default egress); any network access is opt-in per task via an explicit allowlist. The agent must not attempt to disable, weaken, or escape its own sandbox, and any such attempt is a hard failure that halts execution and is logged. The isolation constraint applies to ALL generated or user-supplied executable content — Python, shell, notebook cells, compiled binaries, package build/post-install scripts, test runners, browser automation, document macros, build systems, and dynamically invented/registered custom tools — not just run_python.",
    enforcement: "Enforced at the ExecutionBackend layer (not by prompt/instruction alone): host has no path to invoke code outside a sandbox; egress is blocked at the network namespace level; self-modification of sandbox config is rejected by the backend. The backend does not classify intent. It enforces boundaries unconditionally: forbidden syscalls/operations return a typed policy-denial error to the code (which may continue), and the denial is logged. Dynamically registered custom tools (cap_dynamic_tool_invention_6) must run entirely within this sandbox boundary, and their validation/conformance tests must be executed inside an identical isolated sandbox.",
    secret_policy: "Default: no secrets in the sandbox. Secrets are opt-in, task-scoped, least-privilege, and injected via a broker; where possible the sandbox makes brokered calls rather than seeing the raw secret. Secret values are masked in stdout/stderr/logs and excluded from artifact capture. Egress permitted while a secret is present is restricted to that secret's authorized scope. Tests: env dump does not leak secret to logs, secret file is never captured as an artifact, egress to non-scoped host is blocked while secret is injected.",
    network_policy: "Egress is deny-by-default and enforced at the network-namespace/firewall layer, not in code. When enabled, allowlists are per-host + per-port + per-protocol. DNS is resolved by a policy-controlled resolver; resolved IPs are validated and any resolving to private, loopback, link-local, multicast, or cloud-metadata ranges (IPv4 and IPv6) are blocked. HTTP redirects are re-validated against the allowlist and re-checked for private-IP targets. All attempted destinations are logged. Package fetch uses a separate egress profile not inherited by runtime. Note: Safe host-side gateway tools (such as cap_external_search_api_4) bypass sandbox egress limits by executing entirely on the host side, but must implement a per-tool allowlist of allowed destinations, enforce IP validation blocking private/loopback/link-local/cloud-metadata addresses, reject HTTP redirects to disallowed targets, and pass a dedicated conformance test analogous to the sandbox egress tests. Host-side tools are strictly isolated from leaking secrets, sandbox-internal paths, or host environment variables in logs or outputs.",
    tests: [
      "direct host execution path does not exist / is rejected",
      "default sandbox has no outbound network (egress attempt fails)",
      "allowlisted endpoint is reachable only when explicitly enabled for the task",
      "attempt to modify sandbox limits from inside is rejected and logged",
      "port-scan of a non-authorized public IP is refused/blocked",
      "egress target outside the task allowlist is denied",
      "high-rate requests to an allowed host are rate-limited",
      "request to distribute a flagged malware payload is refused",
      "env dump does not leak secret to logs",
      "secret file is never captured as an artifact",
      "sandbox code cannot intercept or spoof host-side gateway search requests",
      "host-side gateway tools reject connections to private, loopback, and cloud-metadata ranges even during redirects",
      "host-side gateway tool logs and error outputs are sanitized and never contain secrets, sandbox paths, or host environment variables",
      "dynamically registered custom tools are executed inside the sandboxed environment with no direct host access"
    ]
  }
];
