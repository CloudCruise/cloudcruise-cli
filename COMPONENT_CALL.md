# COMPONENT_CALL alignment

This branch begins aligning the SDK with the monorepo runtime `COMPONENT_CALL` model for parameterized workflow components. It currently adds only the stable type scaffold (`src/types/components.ts`) mirroring the monorepo runtime types in `packages/types/globalTypes/workflow/workflow-types.ts`.

Full scope is tracked in the monorepo: `dev-docs/design/component-call-master-plan.md` (master plan) and `dev-docs/design/sdk-component-call-alignment.md` (per-repo file targets). Command/client implementation is intentionally gated until the API contract locks.
