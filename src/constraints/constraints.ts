export type Constraint = {
  id: string;
  description: string;
};

export const constraints: { constraints: Constraint[] } = {
  constraints: [
    {
      id: "con_browser_irreversible_actions_8",
      description:
        "The agent must not use browser automation to perform irreversible, sensitive, costly, or identity-bearing actions without explicit user confirmation immediately before the action. This includes purchases, financial transfers, legal/medical/government submissions, account deletion, public posting, sending messages, changing security settings, uploading private files, accepting contracts, CAPTCHA circumvention, or entering credentials. The agent may prepare forms or navigate up to the confirmation boundary, but final submission requires a clear user approval that identifies the site, action, and material consequences. Browser automation must never bypass paywalls, access controls, robots-style restrictions, anti-bot protections, or CAPTCHAs unless the user has authorization and the action is policy-approved.",
    },
  ],
};

export default constraints;
