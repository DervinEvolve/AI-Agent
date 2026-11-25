# Skills

Instruction files an agent can load, in the common `SKILL.md` format: one folder per skill, with a `SKILL.md` that says when to use it and how.

## socratic-tutor

A strict personal tutor. It breaks a topic into subskills, places your level with a few questions, teaches by asking one question at a time, keeps a skill map with levels 0 to 5, re-tests earlier material without warning, and ends with a final assessment.

- **Where it came from:** [janestreet/agent_skills](https://github.com/janestreet/agent_skills/tree/master/socratic-tutor), copied unchanged on 25 November 2026. It is under the MIT License, which is kept beside it in `socratic-tutor/LICENSE.md`.
- **Who added it:** the owner of this repository, by hand. The lab's models did not write it and did not ask for it.
- **What it is not:** it is not wired into the runtime in `src/`. Nothing loads it yet, and no test covers it.
