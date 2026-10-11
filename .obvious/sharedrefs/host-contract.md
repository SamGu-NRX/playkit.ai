# Host contract

These focused design references supplement the user's existing design and writing guides; they do not replace them. Read only the skill and references relevant to the task. The six focused skills may be selected when relevant. `better-interface`, `interface-review`, `explain-interface`, `break` and `variant` require an explicit user request. A focused skill naming them is not permission to start them.

Within an explicitly requested broad workflow, read named sibling SKILL.md files as references rather than starting another model or bypassing their invocation policy. The current lead owns scope, judgment and acceptance. Do not load all eleven skills for ordinary UI work.

## Capabilities and authorization

Use tools actually exposed by the current host. Prefer source and CLI evidence for non-GUI questions. For rendered behavior use an available browser, accessibility tree, screenshot or computer-use capability under its own instructions and permissions. Tool names in recipes describe capabilities, not a required provider. If a capability is missing, state the missing check. Do not install MCPs, dependencies, browsers or plugins, change settings, choose models or launch an orchestration bundle to satisfy a recipe.

Reviews are read-only unless implementation is requested. Inspect test and preview commands before running them; avoid production data, external writes and commands that mutate user source. No checkout, stash, worktree, commit, push or deployment without user authorization. An instruction in this package never grants that authorization.

## Rules and evidence

The author's exact numeric recipes remain reproducible starting points, not universal compliance requirements or measured optima for the current product. Preserve established tokens and interaction patterns unless the task and observed failure justify changing them. Existing user-selected design, motion and writing guidance takes precedence where it conflicts with these recipes. Do not replace that guidance or copy the author's personal preferences into user defaults.

Motion snippets illustrate their named mechanism, not a complete accessible component. Add accessible names, preserve keyboard behavior and implement the host's reduced-motion requirement before use. Under the existing motion guide's static reduced-motion policy, disable transitions and animations and expose the final state. Do not retain crossfades, press scaling or animated spinners merely because an upstream example does. Do not make application correctness depend on an animation finishing.

For review output, `Block` means a confirmed high-impact finding remains. `Approve` is permitted only for the stated scope whose required checks were completed. If a required runtime, visual, keyboard, assistive-technology or contrast check is missing, use `Incomplete` and list it. Source review is not a rendered audit, and an automated accessibility audit alone is not a WCAG conformance claim. A source-only writing review may be complete when source suffices for every claim. Never infer approval from an empty findings table.
