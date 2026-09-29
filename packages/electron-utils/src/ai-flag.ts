/**
 * Master switch for the AI feature set (AI panels, AI ribbon buttons, AI
 * settings panes, and the `ai:*` IPC handlers).
 *
 * `false` hides every user-facing AI entry point and makes the main processes
 * decline to register the `ai:*` channels, so no renderer code path can reach
 * an AI provider. All AI code stays in the tree: flipping this to `true`
 * restores the full AI feature set. Unrelated features that talk to the
 * network through ai-search — Genspark account sign-in, cloud projects, and
 * slides cloud deck generation — are intentionally NOT gated by this flag.
 */
export const AI_ENABLED = false
