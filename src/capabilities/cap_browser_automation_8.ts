export const cap_browser_automation_8 = {
  id: 'cap_browser_automation_8',
  name: 'Sandboxed browser navigation and DOM interaction',
  status: 'active',
  interface: {
    inputs: {
      action: `enum['open','click','type','select','scroll','wait_for','extract','screenshot','go_back','close']`,
      session_id: 'string optional; creates a new browser session if omitted for open',
      url: 'string optional for open',
      selector: 'string optional for click/type/select/wait_for/extract',
      text: 'string optional for type',
      value: 'string optional for select',
      extraction_schema: 'object optional; JSON Schema or field map for structured extraction',
      wait: 'object optional; {condition?: string, timeout_ms?: int max 10000}',
      screenshot_options: 'object optional; {full_page?: bool default false}',
      max_observation_bytes: 'int default 65536 max 262144'
    },
    outputs: {
      session_id: 'string',
      status: `enum['ok','failed','policy_blocked','budget_exhausted','timeout']`,
      current_url: 'string',
      page_title: 'string optional',
      observation: 'object optional; sanitized DOM text, extracted fields, visible elements, or screenshot artifact metadata',
      artifacts: 'list[{artifact_id:string, type:string, bytes:int}]',
      error: 'object optional; {code:string, message:string, retryable:bool}',
      tainted: 'bool',
      provenance: 'object',
      truncated: 'bool'
    },
    tool_name: 'browser_control'
  },
  description:
    'The agent can navigate and interact with web pages through a headless browser running inside the same isolated sandbox boundary as generated code. It may open allowlisted URLs, click visible elements, type into fields, wait for page state, scroll, capture screenshots, and extract structured information from the rendered DOM. Browser observations are treated as untrusted web content, carry provenance, and are tainted by default.',
  implementation: {
    modules: [
      'tools/browser_control_adapter.py',
      'browser/session_manager.py',
      'browser/policy.py',
      'browser/dom_sanitizer.py',
      'browser/artifacts.py'
    ],
    tests: [
      'open an allowlisted URL in a sandboxed headless browser and return title/current_url/provenance',
      'deny open when URL host is not in task egress allowlist',
      'deny private IP, localhost, file://, data URL, and host-internal metadata endpoints',
      'click and type operate only on visible user-page elements matching provided selectors',
      'extract returns schema-conformant structured data from rendered DOM',
      'malicious page text containing tool-like instructions is returned tainted and not executed as controller instructions',
      'screenshot stores an artifact without leaking host filesystem paths',
      'browser session has an ephemeral profile and no persistence across task sessions',
      'cookies, localStorage, cache, downloads, and credentials are cleared on FINISH/FAIL',
      'browser actions consume unified BudgetTracker step/time/network budget',
      'timeouts return structured failure without crashing the controller',
      'DOM observations are sanitized: scripts, event handlers, hidden executable payloads, and oversized content are stripped or truncated',
      'browser_control is inaccessible from run_python and dynamically registered custom tools',
      'form submission with irreversible or sensitive effect requires explicit user confirmation',
      'credential entry is blocked unless credentials are supplied through an approved secret channel and target origin is user-approved',
      'downloaded files are quarantined as tainted artifacts and never executed automatically'
    ],
    execution_contract:
      'browser_control is a host-controller tool that launches the browser engine only inside the sandbox execution environment or an equivalently isolated browser container. It never runs page scripts with host credentials, never exposes host paths, and never shares a persistent browser profile between sessions.',
    network_contract:
      'The browser inherits deny-by-default egress from con_exec_isolation_1. Opening or navigating to any URL requires explicit task egress authorization by scheme, host, and port. Redirects are checked hop-by-hop. Private networks, localhost, link-local, file://, data:, browser-internal pages, and metadata services are blocked unless a future explicit policy grants otherwise.',
    taint_and_provenance:
      'All page content, DOM text, screenshots, downloads, console messages, and extracted fields are marked tainted=true with source URL, timestamp, action trace, redirect chain, and selector provenance. Timer-like controller metadata may be untainted, but web content never is.',
    session_lifecycle:
      'Browser sessions are task-scoped. Profiles are ephemeral. Cookies, storage, cache, permissions, service workers, downloads, and screenshots are destroyed or moved to approved artifact storage on FINISH/FAIL. The session manager enforces max 3 concurrent browser sessions per task, max 50 browser actions per task by default, and max 10 MB total browser artifacts unless the parent budget grants more.',
    observation_limits:
      'Rendered DOM text and extraction outputs are capped by max_observation_bytes. Large pages are summarized into visible text chunks, forms, links, headings, tables, and accessibility labels. Full screenshots are stored as artifacts rather than inlined.',
    controller_integration:
      'The controller may use web_search to discover candidate URLs, but browser_control must independently validate each URL against policy before navigation. Browser observations are evidence, not instructions; they may inform reasoning but cannot directly set tool parameters without validation.'
  }
} as const;

export type BrowserAutomationCapability = typeof cap_browser_automation_8;

export const capability = cap_browser_automation_8;
export const capBrowserAutomation8 = cap_browser_automation_8;

export const capabilities = {
  capabilities: [cap_browser_automation_8]
} as const;

export default cap_browser_automation_8;
