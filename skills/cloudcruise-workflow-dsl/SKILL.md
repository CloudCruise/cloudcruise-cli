---
name: cloudcruise-workflow-dsl
description: CloudCruise workflow DSL reference — node types and parameters, STATIC vs LLM_VISION execution, edge structure, variables and JSONata, run_if guards, XPath rules, data-model schema extensions, and error classification. Read before writing, editing, or debugging any CloudCruise workflow node.
---

# CloudCruise Workflow DSL Reference

A workflow is a directed graph of nodes (actions) connected by edges. The browser agent executes nodes sequentially, following edges, to automate a business process.

## Workflow Structure

```json
{
  "id": "uuid (read-only)",
  "version_number": 1,
  "name": "My Workflow",
  "description": "Optional description",
  "nodes": [ ... ],
  "edges": { ... },
  "input_schema": { "type": "object", "properties": { ... } },
  "output_schema": { "type": "object", "properties": { ... } },
  "max_retries": 3,
  "vault_schema": { "alias": { "type": "credential", "domain": "example.com" } }
}
```

### Read-Only Fields

`id`, `version_id`, `version_number`, `created_at`, `created_by`, `updated_at`, `workspace_id`, `workflow_id`, `conversation_id`

Leave them in the body from `workflows get`; `workflows update` sends it as-is. `version_id` drives the stale check: the update fails with exit 13 if a newer version exists (`--force` overrides). `id`, `workflow_id` and `workspace_id` must match the target workflow.

### Mutable Fields (accepted by PUT)

**Required:** `nodes`, `edges`, `name`, `input_schema`, `output_schema`, `max_retries`

**Optional:** `description`, `version_note` (on `workflows update`, set via `--version-note` only), `use_native_actions`, `video_record_session`, `extract_network_urls`, `popup_xpaths`, `vault_schema`, `enable_popup_handling`, `enable_action_timing_recovery`, `enable_xpath_recovery`, `enable_error_code_generation`, `enable_service_unavailable_recovery`, `enable_incorrect_form_input_recovery`, `enable_password_update_recovery`, `enable_tfa_setup_recovery`, `enable_node_description_enrichment`, `allow_requeue`, `deny_requeue_past_dry_run_marker`, `proxy_setting`, `proxy_value`, `enable_network_listener`, `manual_captcha_solve`

### `popup_xpaths`

An array of XPath selectors that identify dismissible popups (cookie banners, survey modals, chat widgets, etc.). When `enable_popup_handling` is `true`, the runtime checks for elements matching these XPaths before each node executes and clicks them to dismiss. Set it at the workflow level only. Node-level `popup_xpaths` is ignored (the runtime overwrites it from the workflow level) — do not set it.

## Variables

Variables use double curly braces: `{{expression}}`.

| Source          | Path                | Example                            |
| --------------- | ------------------- | ---------------------------------- |
| Input variables | `context.inputs.*`  | `{{context.inputs.order_id}}`      |
| Extracted data  | `context.*`         | `{{context.customer_name}}`        |
| Loop runtime    | `context.runtime.*` | `{{context.runtime.current_item}}` |
| Browser URL     | `window.location.*` | `{{window.location.href}}`         |

Variables can be used in: text inputs, XPath selectors, URLs, prompts, data model field names.

**Data transformation and logic** uses [JSONata](https://jsonata.org/) expressions inside `{{}}`. Use JSONata for complex string operations, conditional logic, array filtering, and data formatting instead of adding extra nodes.

Common patterns:

```
{{$fromMillis($toMillis(context.inputs.date, "[Y0001]-[M01]-[D01]"), "[M01]/[D01]/[Y0001]")}}
{{$uppercase(context.inputs.name)}}
{{$trim(context.inputs.value)}}
{{$substring(context.inputs.phone, 0, 3)}}
{{$join(context.items, ", ")}}
{{$count(context.results)}}
{{context.inputs.amount > 100 ? "high" : "low"}}
{{context.drug in ["Skyrizi", "Tremfya", "Botox"]}}
{{$contains(context.inputs.email, "@gmail.com")}}
{{$not($contains(context.page_text, "error"))}}
{{$string(context.inputs.number)}}
{{$number(context.inputs.string_amount)}}
```

JSONata is especially useful in BoolCondition `comparison_value_1` for complex conditions that go beyond simple `EQUAL`/`IS_NULL` operators (see BoolCondition section below).

## Execution Types

| Type          | Description                                                                 | Used By                                                                    |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `STATIC`      | Explicit XPath selectors. Fast and reliable. **Prefer this when possible.** | Click, InputText, InputSelect, Scroll, BoolCondition, ExtractDatamodel, TFA |
| `LLM_VISION`  | AI decision or extraction from screenshot                                   | Click, InputText, Scroll, BoolCondition, ExtractDatamodel, TFA             |
| `LLM_DOM`     | AI extraction from HTML DOM structure                                       | ExtractDatamodel                                                           |
| `PROMPT`      | AI reasoning on context data (no screenshot)                                | BoolCondition, ExtractDatamodel                                            |

## Writing Good XPath Selectors

For STATIC execution on Click, Input Text, and Input Select: **the XPath must match exactly one element**. Matching zero (not found) or multiple (ambiguous) elements fails the run.

### Objectives

1. **Unique** – The selector must match exactly one element on the page.
2. **Robust** – Should work despite minor DOM changes (e.g., unrelated element insertions, class reordering).
3. **Semantic** – Prefer meaningful attributes or visible text over structural hacks.

### Strategy (in priority order)

1. **Stable attributes first**: Use semantic `@id`, `@name`, `@data-*`, `@aria-label`, `@placeholder` attributes when they are human-readable and stable. Ignore scrambled/generated IDs (e.g., `app-title-5ubdNjG9AIzOgXfv0b1J2`).

2. **Text content**: Use `normalize-space()` for matching visible text. Never use bare `text()`. Use `lower-case(normalize-space())` for case-insensitive matching when needed.

   ```
   //button[normalize-space()='Submit']
   //a[contains(normalize-space(), 'View Details')]
   ```

3. **Structural anchors**: When attributes/text are insufficient, anchor to nearby semantic elements (labels, headings, section titles).

   ```
   //label[normalize-space()='Country']/following-sibling::select
   //h2[normalize-space()='Billing']/following-sibling::div//input[@name='address']
   ```

4. **Tag names over wildcards**: Prefer `//button` over `//*` unless no tag name is stable.

5. **Dynamic selectors with variables**: Use workflow variables for data-driven targeting.

   ```
   //tr[@data-id='{{context.order_id}}']//button
   //input[@name='{{context.runtime.current_field}}']
   ```

### Avoid

- Non-semantic class names (e.g., `css-1huvxym-option`, `sc-bdfBwQ`)
- Scrambled/generated IDs (e.g., `app-title-5ubdNjG9AIzOgXfv0b1J2`)
- Deep positional paths like `div[3]/span[2]/a[1]` -- these break on minor DOM changes
- Unnecessary positional indices `[1]` unless unavoidable (and then wrap: `(//div[@class='result'])[1]`)

### Technical Notes

- Always use `normalize-space()` instead of `text()` for visible text matching
- When a selector is too fragile or complex to maintain, switch the node to `LLM_VISION` execution instead

## Edges

Edges are a map of `source_node_id → target`. The target type depends on the source node:

```json
{
  "node-1": { "to": "node-2" },
  "node-2": { "true": "node-3", "false": "node-4" },
  "node-5": { "loop_not_done": "node-6", "loop_done": "node-7" }
}
```

| Edge Key                      | Used By        | Meaning                          |
| ----------------------------- | -------------- | -------------------------------- |
| `to`                          | Most nodes     | Next node in sequence            |
| `true` / `false`              | BOOL_CONDITION | Branch based on condition result |
| `loop_not_done` / `loop_done` | LOOP           | Continue iterating / exit loop   |

## Conditional skip (`run_if`)

A node runs only if its `parameters.run_if` holds; otherwise the run skips to the node's `to` edge.

```json
"run_if": {
  "match": "all",
  "conditions": [
    { "field": "context.inputs.provider.middle_name", "operator": "IS_NOT_NULL" }
  ]
}
```

| Field                   | Values                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `match`                 | `all` (default) or `any`                                                                                 |
| `conditions[].field`    | Path under `context.`                                                                                    |
| `conditions[].operator` | `EQUAL`, `NOT_EQUAL`, `CONTAINS`, `NOT_CONTAINS`, `IS_NULL`, `IS_NOT_NULL`, `STARTS_WITH`, `ENDS_WITH` |
| `conditions[].value`    | String; omit for `IS_NULL` and `IS_NOT_NULL`                                                             |

`IS_NULL` treats `null`, missing, `""`, `"null"` and `[]` as absent.

**Supported on:** CLICK, INPUT_TEXT, INPUT_SELECT, EXTRACT_DATAMODEL, EXTRACT_NETWORK, SCREENSHOT, TFA, FILE_DOWNLOAD and API_FLOW. Other node types reject it (`property run_if should not exist`).

**Gating structural nodes:**

- **DELAY:** if the next gated node's element only appears after this step, drop the DELAY and raise that node's `wait_time`; otherwise route around the DELAY as for SCROLL.
- **SCROLL (or any other unsupported node):** route around it with a BOOL_CONDITION on the same condition.
- **BOOL_CONDITION:** it can't be skipped. Route around it as for SCROLL, or gate the nodes on its branches. Fold the gate into its comparison only when a false gate should take its false path.

## Node Structure

Every node has:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Descriptive name (important for maintenance agent recovery)",
  "action": "ACTION_TYPE",
  "parameters": { ... }
}
```

**IMPORTANT:** The `id` field must be a valid UUID (e.g., `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`). Do not use natural language IDs like `"click-submit-button"`. Generate UUIDs with `cloudcruise utils uuid`.

## Node Types

### START

Entry point. Every workflow has exactly one.

```json
{
  "id": "b7e9a2f1-3c4d-4a8b-9e1f-2d3c4b5a6789",
  "name": "Open site",
  "action": "START",
  "parameters": {
    "url": "https://app.example.com/login"
  }
}
```

| Parameter | Type   | Required | Description  |
| --------- | ------ | -------- | ------------ |
| `url`     | string | Yes      | Starting URL |

### END

Exit point. No parameters needed.

```json
{
  "id": "c3d4e5f6-7890-4abc-def1-234567890abc",
  "name": "Done",
  "action": "END",
  "parameters": {}
}
```

### CLICK

Click on page elements.

```json
{
  "id": "d4e5f6a7-8901-4bcd-ef23-456789abcdef",
  "name": "Click submit button",
  "action": "CLICK",
  "parameters": {
    "execution": "STATIC",
    "selector": "//button[@type='submit']",
    "wait_time": 10000
  }
}
```
| Parameter                | Type    | Required         | Description                                                                                                                                                                        |
| ------------------------ | ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution`              | string  | Yes              | `STATIC` or `LLM_VISION`                                                                                                                                                           |
| `selector`               | string  | Yes (STATIC)     | XPath selector                                                                                                                                                                     |
| `prompt`                 | string  | Yes (LLM_VISION) | Natural language target description                                                                                                                                                |
| `click_type`             | string  | No               | `click` (default), `double_click`, `right_click`, `hover`                                                                                                                          |
| `wait_time`              | number  | No               | Max ms to wait for element. Default: 15000                                                                                                                                         |
| `selector_error_message` | string  | No               | Error code id (UUID) to fail with if the element is not found. See [Error Codes](#error-codes)                                                                                    |
| `human_mode`             | boolean | No               | Human-like click behavior                                                                                                                                                          |
| `end_here_on_dry_run`    | boolean | No               | Skip this node and end the workflow during dry runs. Set on the final submit/save click of write workflows so dry runs validate everything without submitting to the target system |

### INPUT_TEXT

Type text into form fields.

```json
{
  "id": "e5f6a7b8-9012-4cde-f345-6789abcdef01",
  "name": "Enter username",
  "action": "INPUT_TEXT",
  "parameters": {
    "execution": "STATIC",
    "selector": "//input[@id='username']",
    "text": "{{context.inputs.username}}"
  }
}
```

| Parameter             | Type    | Required         | Description                                                                                                             |
| --------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `text`                | string  | Yes              | Text to type (supports variables and JSONata). `{{...}}` keystroke tokens press keys — see below                        |
| `execution`           | string  | Yes              | `STATIC` or `LLM_VISION`                                                                                                |
| `selector`            | string  | Yes (STATIC)     | XPath selector                                                                                                          |
| `prompt`              | string  | Yes (LLM_VISION) | Natural language field description                                                                                      |
| `do_not_clear`        | boolean | No               | Append without clearing existing content                                                                                |
| `submit_after_input`  | boolean | No               | Press Enter after typing                                                                                                |
| `aggressive_clear`    | boolean | No               | Adds a second clear pass. Enable only after observing typing leaves old text behind or appends to it — not preemptively |
| `wait_time`           | number  | No               | Max ms to wait. Default: 15000                                                                                          |
| `human_mode`          | boolean | No               | Human-like typing behavior                                                                                              |
| `end_here_on_dry_run` | boolean | No               | In dry runs, end the workflow before this node runs                                                                    |
| `omit_focus`          | boolean | No               | Send the keys to whatever currently has focus. No `selector`, no click, no clearing     |
| `paste_via_clipboard` | boolean | No               | Paste the resolved text via the OS clipboard (ctrl+v) instead of typing it. Ignored when `text` has keystroke tokens |
| `typing_delay_ms`     | integer | No               | Delay between keystrokes in ms (1–1000). Use when typed characters get dropped, e.g. over RDP |

**Keystroke tokens.** `text` presses a key wherever it contains one of the tokens below; any other `{{...}}` goes through normal variable and JSONata interpolation. Tokens and text within one node run in order, so `"john{{tab}}secret{{enter}}"` types, tabs, types, enters. Reach for these only when the user asks for them or the site offers no other way — ordinary `CLICK` and `INPUT_TEXT` nodes remain the default.

| Token                                         | Key                                               |
| --------------------------------------------- | ------------------------------------------------- |
| `{{tab}}`                                     | Tab                                               |
| `{{enter}}`, `{{return}}`                     | Enter                                             |
| `{{escape}}`, `{{esc}}`                       | Escape                                            |
| `{{space}}`                                   | Space                                             |
| `{{backspace}}`                               | Backspace                                         |
| `{{delete}}`, `{{del}}`                       | Delete                                            |
| `{{up}}`, `{{down}}`, `{{left}}`, `{{right}}` | Arrow keys (`{{arrow_up}}` and friends also work) |
| `{{ctrl_a}}`, `{{ctrl_c}}`, `{{ctrl_v}}`      | Select all, copy, paste                           |

Keep the `selector` when the keys belong in a field that must be focused first. The node clicks the element before typing, so the selector must be the field itself, and a key that follows the text acts on whatever that field opened.

For keys with no field to type into, set `omit_focus: true` and give no `selector` and no `prompt`.

### INPUT_SELECT

Select options from dropdowns. Handles native `<select>`, Select2, and similar libraries.

```json
{
  "id": "f6a7b8c9-0123-4def-a567-89abcdef0123",
  "name": "Select country",
  "action": "INPUT_SELECT",
  "parameters": {
    "selector": "//select[@id='country']",
    "value": "United States"
  }
}
```

| Parameter     | Type    | Required | Description                                                                        |
| ------------- | ------- | -------- | ---------------------------------------------------------------------------------- |
| `value`       | string  | No       | Option value or text to select                                                     |
| `selector`    | string  | Yes      | XPath to the select element                                                        |
| `fuzzy_match` | boolean | No       | Fuzzy matching for option values (e.g., "New Patient" matches "New Patient Visit") |
| `execution`   | string  | No       | `STATIC` (default). Other values are accepted but ignored: the node always uses `selector` |
| `wait_time`   | number  | No       | Max ms to wait. Default: 15000                                                     |
| `end_here_on_dry_run` | boolean | No | In dry runs, end the workflow before this node runs                            |

### NAVIGATE

Navigate browser to a URL.

```json
{
  "id": "a7b8c9d0-1234-4ef5-b678-9abcdef01234",
  "name": "Go to dashboard",
  "action": "NAVIGATE",
  "parameters": { "url": "https://app.example.com/dashboard" }
}
```

| Parameter | Type   | Required | Description                                                            |
| --------- | ------ | -------- | ---------------------------------------------------------------------- |
| `url`     | string | Yes      | URL to navigate to. Use `"back"` for browser back. Supports variables. |

### EXTRACT_DATAMODEL

Extract structured data from the page using a JSON schema.

```json
{
  "id": "b8c9d0e1-2345-4f67-c890-abcdef012345",
  "name": "Extract order details",
  "action": "EXTRACT_DATAMODEL",
  "parameters": {
    "execution": "STATIC",
    "extract_data_model": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "selected": true,
          "path": "//span[@data-testid='order-id']",
          "mode": "xpath"
        },
        "total": {
          "type": "string",
          "selected": true,
          "path": "//div[@class='total']//span",
          "mode": "xpath"
        }
      }
    }
  }
}
```

| Parameter            | Type    | Required        | Description                                                                                                              |
| -------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `extract_data_model` | object  | Yes             | JSON Schema with CloudCruise extensions (see below)                                                                      |
| `execution`          | string  | No              | `STATIC`, `LLM_DOM` (default), `LLM_VISION`, or `PROMPT`                                                                 |
| `selector`           | string  | Yes (`LLM_DOM`) | XPath to scope extraction area                                                                                           |
| `prompt`             | string  | Yes (`PROMPT`)  | Additional instructions for the model                                                                                    |
| `wait_time`          | number  | No              | Max ms to wait for selector. Default: 15000                                                                              |
| `keep_html_metadata` | boolean | No              | Only used by `LLM_DOM`. Preserve HTML attributes (id, class, data-\*) so the model can extract from them. Default: false |

#### Data Model Schema Extensions

CloudCruise extends JSON Schema with:

| Property             | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `selected`           | Set `true` to include this field in extraction                        |
| `path`               | XPath for STATIC extraction, JSONata/JSONPath for ExtractNetwork      |
| `mode`               | Set `"xpath"` for XPath-based extraction                              |
| `description`        | Helps LLM understand what to extract                                  |
| `overwriteArrayKeys` | Array of keys to overwrite (instead of append) on repeated extraction |

**STATIC array extraction with relative XPaths** (table rows):

```json
{
  "orders": {
    "type": "array",
    "selected": true,
    "path": "//table[@id='orders']//tbody/tr",
    "mode": "xpath",
    "items": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "path": "/td[1]", "mode": "xpath" },
        "name": { "type": "string", "path": "/td[2]", "mode": "xpath" }
      }
    }
  }
}
```

**Browser variables** (STATIC execution only):

```json
{
  "current_url": {
    "type": "string",
    "selected": true,
    "path": "{{window.location.href}}",
    "mode": "xpath"
  }
}
```

**Raw HTML extraction** (STATIC execution only): `{{document.sanitized}}` for clean HTML, `{{document}}` for full HTML.

### BOOL_CONDITION

Conditional branching. Uses `true`/`false` edges.

```json
{
  "id": "c9d0e1f2-3456-4a78-d901-bcdef0123456",
  "name": "Check if logged in",
  "action": "BOOL_CONDITION",
  "parameters": {
    "execution": "STATIC",
    "comparison_operator": "IS_NULL",
    "comparison_value_1": "<<xpath://input[@id='username']>>"
  }
}
```
| Parameter                | Type    | Required                 | Description                                                                |
| ------------------------ | ------- | ------------------------ | -------------------------------------------------------------------------- |
| `execution`              | string  | Yes                      | `STATIC`, `LLM_VISION`, or `PROMPT`                                        |
| `comparison_operator`    | string  | Yes (STATIC)             | `EQUAL`, `NOT_EQUAL`, `CONTAINS`, `NOT_CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `IS_NULL`, `IS_NOT_NULL` |
| `comparison_value_1`     | string  | Yes (STATIC)             | First value. Supports variables, JSONata, and `<<xpath:...>>` (see below)  |
| `comparison_value_2`     | string  | No                       | Second value (STATIC). Not needed for IS_NULL/IS_NOT_NULL                  |
| `prompt`                 | string  | Yes (LLM_VISION, PROMPT) | Natural language condition                                                 |
| `clear_cookies_on_false` | boolean | No                       | Clear cookies when false (useful for login flows, default false)           |
| `wait_time`              | number  | No                       | Max ms to wait before evaluation (default 15000)                          |
| `error_on_false_message` | string  | No                       | Error code id (UUID) to fail with when false, instead of following the `false` edge. See [Error Codes](#error-codes) |

#### XPath evaluation with `<<xpath:...>>`

To evaluate a condition against a live DOM element, wrap the XPath in `<<xpath:...>>`. The browser agent locates the element and extracts its text content as the comparison value. If the element is not found, the value resolves to null (useful with `IS_NULL`/`IS_NOT_NULL` to check element existence). Variables work inside the XPath: `<<xpath://tr[normalize-space()='{{context.inputs.name}}']>>`.

```json
{"comparison_operator": "IS_NOT_NULL", "comparison_value_1": "<<xpath://div[@id='error-banner']>>"}
{"comparison_operator": "EQUAL", "comparison_value_1": "<<xpath://span[@data-testid='status']>>", "comparison_value_2": "Approved"}
```

**Use JSONata for complex conditions.** When you need logic beyond simple `EQUAL`/`IS_NULL` (e.g., numeric comparisons, array membership, string operations, compound conditions), evaluate the expression in `comparison_value_1` and compare against `"true"`:

```json
{
  "comparison_value_1": "{{context.drug in [\"Skyrizi\", \"Tremfya\", \"Botox\"]}}",
  "comparison_value_2": "true",
  "comparison_operator": "EQUAL"
}
```

More examples:

```json
{"comparison_value_1": "{{context.inputs.amount > 100}}", "comparison_value_2": "true", "comparison_operator": "EQUAL"}
{"comparison_value_1": "{{$contains(context.page_text, \"success\") and $not($contains(context.page_text, \"pending\"))}}", "comparison_value_2": "true", "comparison_operator": "EQUAL"}
{"comparison_value_1": "{{$count(context.results) > 0}}", "comparison_value_2": "true", "comparison_operator": "EQUAL"}
{"comparison_value_1": "{{$now() > context.inputs.deadline}}", "comparison_value_2": "true", "comparison_operator": "EQUAL"}
```

### LOOP

Iterate over arrays or repeat N times. Uses `loop_done`/`loop_not_done` edges.

```json
{
  "id": "d0e1f2a3-4567-4b89-e012-cdef01234567",
  "name": "Process each order",
  "action": "LOOP",
  "parameters": {
    "variable_over": "{{context.inputs.orders}}",
    "variable_current_item": "current_order",
    "variable_current_index": "order_index"
  }
}
```

| Parameter                | Type   | Required | Description                                                |
| ------------------------ | ------ | -------- | ---------------------------------------------------------- |
| `variable_over`          | string | Yes      | Array to iterate over, or a number for fixed iterations    |
| `variable_current_item`  | string | Yes      | Variable name for current item (`context.runtime.<name>`)  |
| `variable_current_index` | string | Yes      | Variable name for current index (`context.runtime.<name>`) |

The last node in the loop body must edge back to the loop node. Access items via `{{context.runtime.current_order}}`.

### TRANSFORM

Reshape data in `context.*` without touching the browser.

```json
{
  "id": "b4c5d6e7-8901-4234-b567-890123456789",
  "name": "Normalize contact fields",
  "action": "TRANSFORM",
  "parameters": {
    "operations": [
      {
        "type": "SET",
        "target": "context.email_clean",
        "value": "context.inputs.email ~> $trim ~> $lowercase"
      },
      {
        "type": "SET",
        "target": "context.middle_name",
        "value": "context.inputs.provider.middle_name",
        "optional": true
      }
    ]
  }
}
```

| Parameter    | Type  | Required | Description                                                      |
| ------------ | ----- | -------- | ---------------------------------------------------------------- |
| `operations` | array | Yes      | Ordered list of `{ type, target, value?, optional? }` operations |

| Operation field | Type    | Required     | Description                                      |
| --------------- | ------- | ------------ | ------------------------------------------------ |
| `type`          | string  | Yes          | `SET` or `DELETE`                                |
| `target`        | string  | Yes          | Path under `context.` (e.g. `context.email_clean`) |
| `value`         | string  | For `SET`    | Raw JSONata, no `{{...}}`                        |
| `optional`      | boolean | No (`false`) | Allow an empty result                            |

**Every `SET` is required by default:** an empty result (`null`, `""`, `[]`) fails the node with `unmet required output(s)`. Set `optional: true` to allow it; there is no `required` field. Don't use placeholders like `" "`.

Operations run in order and see each other's writes.

- Merge objects: `SET` with `$merge([<target>, <value>])`.
- Append to an array: `SET` with `$append(<target>, [<value>])`.

### DELAY

Pause execution.

```json
{
  "id": "e1f2a3b4-5678-4c90-f123-def012345678",
  "name": "Wait for animation",
  "action": "DELAY",
  "parameters": { "delay_time": 2 }
}
```

| Parameter    | Type   | Required | Description     |
| ------------ | ------ | -------- | --------------- |
| `delay_time` | number | Yes      | Seconds to wait |

To wait after an action, raise the **next** node's `wait_time` (ms; it waits until that node's element appears). Use DELAY or a readiness check only if that element may already exist, isn't usable yet, or the next node has no selector.

### CAPTCHA

Solve one captcha at this point in the run. Runs the platform's solver for the named captcha whether or not the workflow's automatic captcha solving is on.

```json
{
  "id": "f2a3b4c5-6789-4d01-a234-ef0123456789",
  "name": "Solve Turnstile before submit",
  "action": "CAPTCHA",
  "parameters": { "captcha_type": "turnstile" }
}
```

| Parameter      | Type   | Required | Description                                                       |
| -------------- | ------ | -------- | ----------------------------------------------------------------- |
| `captcha_type` | string | Yes      | `turnstile` (Cloudflare Turnstile), `recaptcha_v2`, or `hcaptcha` |

Outcome: no captcha of that type on the page → the node passes and the run continues. Captcha present and solved → passes. Captcha present and not solved → the node fails with error code `CAPTCHA-E0001`, so the workflow's error-code actions (retry, alert, pause) apply. Detection finds the widget's iframe or container in the top page only. A captcha on a page embedded in another iframe is not detected, and the node passes as if no captcha were present.

For `hcaptcha`, when hCaptcha is on the page but no challenge is showing yet, the node waits up to 15 seconds for one to open, and passes as soon as the widget has a token. That is what makes it work right after a `CLICK` on a site's own "I am not a robot" checkbox that opens an invisible hCaptcha: the challenge appears a few seconds after the click, and automatic solving does not wait for it.

### SCREENSHOT

Capture a screenshot.

```json
{
  "id": "f2a3b4c5-6789-4d01-a234-ef0123456789",
  "name": "Screenshot dashboard",
  "action": "SCREENSHOT",
  "parameters": { "metadata": { "screen": "dashboard" } }
}
```

| Parameter     | Type   | Required | Description                                   |
| ------------- | ------ | -------- | --------------------------------------------- |
| `metadata`    | object | No       | Metadata for identification in results        |
| `wait_time`   | number | No       | Max ms to wait. Default: 15000                |
| `margin`      | number | No       | Pixel padding (useful to crop sticky headers) |
| `max_scrolls` | number | No       | Scrolls for full-page capture                 |

### SCROLL

Scroll the page or containers.

**Simple scroll:**

```json
{
  "id": "a3b4c5d6-7890-4e12-b345-f01234567890",
  "name": "Scroll to load more",
  "action": "SCROLL",
  "parameters": {
    "scroll_mode": "simple",
    "direction": "down",
    "load_events_triggered_through_scroll": 3
  }
}
```

**Scroll to element:**

```json
{
  "parameters": {
    "scroll_mode": "to-element",
    "xpath": "//div[@id='target-section']",
    "position": "center"
  }
}
```

**Scroll within container:**

```json
{
  "parameters": {
    "scroll_mode": "region",
    "container_xpath": "//div[@class='scrollable-list']",
    "direction": "down",
    "goal": "full-container"
  }
}
```

| Parameter                              | Type   | Required           | Description                                                                       |
| -------------------------------------- | ------ | ------------------ | --------------------------------------------------------------------------------- |
| `scroll_mode`                          | string | No                 | `simple` (default), `to-element`, or `region`                                     |
| `direction`                            | string | No                 | `up`, `down`, `left`, or `right` (default `down`). Used by `simple` and `region` modes. In `simple` mode, vertical scrolling follows `scroll_down` (default `true`): set `scroll_down: false` to scroll up. With `goal: full-container`, `left` scrolls to the container's start and any other direction to its end |
| `load_events_triggered_through_scroll` | number | Yes                | Number of scroll wheel ticks. Only used by `simple` mode — set to `0` otherwise   |
| `xpath`                                | string | Yes (`to-element`) | XPath of the element to scroll into view                                          |
| `position`                             | string | No                 | `start`, `center`, or `end`. Where the target ends up in the viewport (`to-element` mode) |
| `container_xpath`                      | string | Yes (`region`)     | XPath of the scrollable container                                                 |
| `goal`                                 | string | Yes (`region`)     | `find-element` or `full-container`. `scroll_behavior` takes the same values      |
| `execution`                            | string | No                 | `STATIC` (default) or `LLM_VISION` (screenshot-driven; describe targets in `target_description` / `container_description`). `LLM_VISION` applies only to `to-element` and `region` modes; `simple` ignores it |
| `wait_time`                            | number | No                 | Max ms to wait for elements. Default: 15000                                       |

### TAB_MANAGEMENT

Open, close, or switch browser tabs.

```json
{
  "id": "b4c5d6e7-8901-4f23-c456-012345678901",
  "name": "Open settings tab",
  "action": "TAB_MANAGEMENT",
  "parameters": {
    "tabAction": "OPEN",
    "url": "https://app.example.com/settings"
  }
}
```

| Parameter   | Type   | Required | Description                        |
| ----------- | ------ | -------- | ---------------------------------- |
| `tabAction` | string | Yes      | `OPEN`, `CLOSE`, or `SWITCH`       |
| `url`       | string | No       | URL for OPEN action                |
| `tab_index` | number | No       | 0-based tab index for SWITCH/CLOSE |
| `wait_time` | number | No       | Max ms to wait for the tab to load (OPEN) or appear (SWITCH). Default: 15000 |

### TFA (Two-Factor Authentication)

Handle 2FA challenges. Automatically extracts codes from SMS/email or generates TOTP.

```json
{
  "id": "c5d6e7f8-9012-4a34-d567-123456789012",
  "name": "Enter 2FA code",
  "action": "TFA",
  "parameters": {
    "tfa_type": "EMAIL",
    "credential": "my_vault_alias",
    "selector": "//input[@id='code']"
  }
}
```

| Parameter            | Type   | Required               | Description                                      |
| -------------------- | ------ | ---------------------- | ------------------------------------------------ |
| `tfa_type`           | string | Yes                    | `SMS`, `EMAIL`, `AUTHENTICATOR`, or `MAGIC_LINK` |
| `credential`         | string | Yes                    | Vault credential key for the 2FA receiver        |
| `selector`           | string | Yes (non-`MAGIC_LINK`) | XPath for code input. `LLM_VISION` finds the field on a screenshot and ignores it |
| `execution`          | string | No                     | `STATIC` (default) or `LLM_VISION`               |
| `link_regex_pattern` | string | No                     | Regex to extract magic link from email           |

Codes are automatically entered and submitted (Enter pressed). No subsequent Click node needed.

### FILE_DOWNLOAD

Capture a file download triggered by a previous Click node.

```json
{
  "id": "d6e7f8a9-0123-4b45-e678-234567890123",
  "name": "Capture invoice",
  "action": "FILE_DOWNLOAD",
  "parameters": {
    "metadata": { "invoice_id": "{{context.invoice_id}}" },
    "selector": "//body",
    "timeout_seconds": 120
  }
}
```

| Parameter                     | Type    | Required | Description                                          |
| ----------------------------- | ------- | -------- | ---------------------------------------------------- |
| `metadata`                    | object  | Yes      | Metadata attached to the download for identification (`{}` if none) |
| `selector`                    | string  | Yes      | XPath; required by API validation (`//body` works)   |
| `trigger_print`               | boolean | No       | Trigger print dialog for PDF generation              |
| `continue_on_failed_download` | boolean | No       | Continue if download times out                       |
| `timeout_seconds`             | number  | No       | Max seconds to wait. Default: 60 (range 5-300)       |

### FILE_UPLOAD

Upload a file to a file input. The OS file dialog must already be open (trigger with a Click node first).

```json
{
  "id": "e7f8a9b0-1234-4c56-f789-345678901234",
  "name": "Upload document",
  "action": "FILE_UPLOAD",
  "parameters": { "signed_file_url": "{{context.inputs.file_url}}" }
}
```

| Parameter         | Type   | Required | Description                                              |
| ----------------- | ------ | -------- | -------------------------------------------------------- |
| `signed_file_url` | string | Yes      | Pre-authenticated URL to the file                        |
| `file_name`       | string | No       | Custom file name (with extension) to use when uploading  |

### USER_INTERACTION

Pause for human input. Triggers `interaction.waiting` webhook.

```json
{
  "id": "f8a9b0c1-2345-4d67-a890-456789012345",
  "name": "Get approval code",
  "action": "USER_INTERACTION",
  "parameters": {
    "server_message": "Enter the approval code shown on the device",
    "expected_datamodel": {
      "type": "object",
      "properties": {
        "approval_code": { "type": "string" }
      },
      "required": ["approval_code"]
    },
    "timeout": 180000
  }
}
```

| Parameter            | Type   | Required | Description                                 |
| -------------------- | ------ | -------- | ------------------------------------------- |
| `expected_datamodel` | object | Yes      | JSON Schema for data to collect             |
| `server_message`     | string | No       | Message shown to user (supports variables)  |
| `timeout`            | number | No       | Max ms to wait for response. Default: 180000, max: 270000 |
| `error_message`      | string | No       | Error code id (UUID) to fail with on timeout. See [Error Codes](#error-codes) |

While a run is paused on this node, submit the collected data with `cloudcruise run respond <session_id> --data '{"approval_code":"123456"}'` (keys must match `expected_datamodel`). The user's input becomes available to later nodes via `{{context.<key>}}`.

### EXTRACT_NETWORK

Intercept XHR/Fetch requests and extract data from responses.

```json
{
  "id": "a9b0c1d2-3456-4e78-b901-567890123456",
  "name": "Extract API data",
  "action": "EXTRACT_NETWORK",
  "parameters": {
    "url": "/api/v1/users",
    "extract_data_model": {
      "type": "object",
      "properties": {
        "user_id": { "type": "string", "path": "$.id", "selected": true },
        "email": { "type": "string", "path": "$.email", "selected": true }
      }
    }
  }
}
```

| Parameter            | Type    | Required | Description                                        |
| -------------------- | ------- | -------- | -------------------------------------------------- |
| `url`                | string  | Yes      | URL pattern (exact, substring, or `regex:` prefix) |
| `extract_data_model` | object  | Yes      | Schema with JSONata/JSONPath `path` expressions    |
| `selector`           | string  | No       | XPath to wait for before extracting                |
| `wait_time`          | number  | No       | Max ms to wait for selector. Default: 15000        |
| `full_request`       | boolean | No       | Include full request/response metadata             |
| `end_here_on_dry_run` | boolean | No      | In dry runs, end the workflow before this node runs |

Path syntax: `$` (root), `$.field` (direct), `$.parent.child` (nested), `$[0]` (array index).

### API_FLOW

Replay a chain of HTTP (XHR/fetch) requests as one atomic node — not a UI interaction. Runs in the browser's live session, so cookies attach natively. With `credentials: "omit"`, the requests run cookie-free through a server-side relay instead. Edges: `to`.

```json
{
  "id": "e2f3a4b5-6789-4c01-d234-56789abcdef0",
  "name": "Search stories, then fetch the top one (API)",
  "action": "API_FLOW",
  "parameters": {
    "target_step_id": "story",
    "credentials": "include",
    "steps": [
      {
        "kind": "http",
        "id": "search",
        "label": "Search stories",
        "method": "POST",
        "url": "https://api.example.com/search",
        "body": { "type": "json", "value": { "query": "{{ context.inputs.search_query }}", "page": 0 } },
        "replay_target": {},
        "extract": [
          { "name": "top_id", "source": "response_body", "expression": "hits[0].id", "required": true }
        ]
      },
      {
        "kind": "http",
        "id": "story",
        "label": "Fetch top story",
        "method": "GET",
        "url": "https://api.example.com/items/{{ steps.search.top_id }}",
        "replay_target": {},
        "extract": [
          { "name": "title", "source": "response_body", "expression": "title", "required": true }
        ]
      }
    ],
    "field_json_map": "{ \"top_story_title\": steps.story.title }"
  }
}
```

**Node parameters:**

| Parameter         | Type   | Required | Description                                                                                                                                         |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`           | array  | Yes      | `ApiRequestStep[]` (see below). Max 20. Steps run in array order — put a step after every step it references                                         |
| `target_step_id`  | string | Yes      | The step whose result is published to the workflow context                                                                                          |
| `credentials`     | string | No       | `include` (default; browser cookies attach natively — never thread cookies yourself), `same-origin`, or `omit` (cookie-free server-side relay)        |
| `redirect_policy` | string | No       | `follow` (default) or `manual` (capture a redirect's `Location` instead of following it, e.g. an OAuth `code`). Per-step override allowed           |
| `ordering`        | array  | No       | `{ from_step_id, to_step_id, reason }[]`. Only for a step that must run first with no value flowing between them (e.g. a `Set-Cookie` side effect). Array order must already satisfy it |
| `field_json_map`  | string | No       | JSONata over `{ steps, context }`. Top-level keys deep-merge into `context` (`top_story_title` → `context.top_story_title`, visible to `output_schema`). Keys under `runtime` stay out of the run result. Reference only `steps.<target_step_id>.*` |
| `run_if`          | object | No       | See [`run_if`](#conditional-skip-run_if)                                                                                                            |

**`steps[]` (`ApiRequestStep`):**

| Field                  | Type   | Required | Description                                                                                                            |
| ---------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                   | string | Yes      | `^[a-z][a-z0-9_]{0,63}$`, unique within the node                                                                       |
| `label`                | string | Yes      | Human-readable step name                                                                                               |
| `method`               | string | Yes      | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`                                                             |
| `url`                  | string | Yes      | Full URL; may contain `{{ }}` refs                                                                                     |
| `replay_target`        | object | Yes      | Always set; `{}` (top frame) for almost everything. `{ "frame": { "kind": "iframe", "url_pattern": "...", "ancestry_origins": [...] } }` only for a request fired from inside an iframe |
| `kind`                 | string | No       | `http` (default)                                                                                                       |
| `query`                | object | No       | `{ name: value }`; value may be a literal, a `{{ }}` ref, or a string array (repeats the param). Max 40               |
| `headers`              | object | No       | Same shape as `query`. Max 40. Never hand-write `Authorization`/`Cookie`; they come from the browser or a `{{ steps.* }}` ref |
| `body`                 | object | No       | See below. Omit for no body                                                                                            |
| `extract`              | array  | No       | See below. Later steps read values as `{{ steps.<id>.<name> }}`                                                        |
| `repeat`               | object | No       | Pagination; see below                                                                                                  |
| `expected_status`      | object | No       | `{ "range": "2xx" }` (default) or `{ "values": [200, 201] }`                                                           |
| `graphql_error_policy` | string | No       | GraphQL only: `fail_on_any` (default)                                                                                  |
| `protocol_hint`        | string | No       | `rest`, `graphql`, or `other`. UI hint only                                                                            |

Other per-step fields (`mutation_severity`, `is_auth_refresh`, `response_type`, `retry`, `timeout_ms`, `max_response_bytes`) have method-derived defaults. Leave them out unless needed. A per-step `redirect_policy` overrides the node's. `retry` is not allowed on `POST`/`PATCH`; `retry.max_attempts` ≤ 5.

**`extract` entries** (unique `name` per step):

| `source`          | Shape                                                       | Notes                                                                    |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `response_body`   | `{ name, source, expression }`                              | JSONata path into the parsed body (GraphQL: `data.*`)                    |
| `response_header` | `{ name, source, header }`                                  | Header name to read                                                      |
| `response_text`   | `{ name, source, pattern, flags?, group? }`                 | JS regex over the raw text, for non-JSON responses. Returns one match    |

Set `required: true` on every entry unless the value is genuinely optional. Without it, a missing value interpolates as empty and the failure surfaces downstream instead of at this step. For multiple matches, use JSONata `$match(...)` in `field_json_map` or a `response_body` expression.

**`body`** (one shape per `type`):

| `type`            | Shape                                                    |
| ----------------- | -------------------------------------------------------- |
| `json`            | `{ "type": "json", "value": <any JSON> }` — put `{{ }}` refs directly in JSON values |
| `form_urlencoded` | `{ "type": "form_urlencoded", "value": { "field": "value" } }` |
| `text`            | `{ "type": "text", "value": "raw string" }`              |
| `multipart` / `binary` | File uploads. Rare                                  |

**`repeat`** (pagination — one step, many requests):

| Field            | Description                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `cursor.from`    | Reads the next cursor from each response. Same shapes as `extract`, without `required`                     |
| `cursor.into`    | `{ location: "url" \| "query" \| "header" \| "body", path }` — where the cursor goes in the next request     |
| `until`          | `{ type: "cursor_absent" }`, `{ type: "empty_collection", path }`, or `{ type: "response_predicate", expression }` |
| `accumulate`     | JSONata path collected from every page into one array, exposed as `steps.<id>.accumulated`                 |
| `max_iterations` | **Required.** Hard cap, max 100                                                                               |

**Value flow:** pass values between steps with an inline `{{ steps.<id>.<name> }}` ref in `url`, `query`, `headers`, or a `body` leaf. There is no bindings list. Refs must name a step in the same node. Keep refs to `steps.*` and `context.*` plain paths: operators like `&` or `$count(...)` over them are rejected at save.

**Same origin:** with `credentials: "include"`, the request fires from the page the run is on. If that page's origin (subdomain included) differs from the request's, the fetch fails. Make sure an earlier node (often `START`) lands on the target origin.

# Error Codes

`error_on_false_message` (BOOL_CONDITION), `error_message` (USER_INTERACTION) and `selector_error_message` (selector nodes) take the **id of a workspace error code**: a lowercase UUID. They do not take a code name, a placeholder or a free-text message.

```bash
# Find-or-create by name: returns the existing code if the name is taken ("created": false)
cloudcruise error-codes create --code CLAIM_NOT_FOUND --description "Claim not found in the portal"
# → {"id":"3f2b9c1e-...","error_code":"CLAIM_NOT_FOUND","created":true,...}

cloudcruise error-codes list                          # All workspace codes
cloudcruise error-codes list --workflow-id <id>       # Codes linked to one workflow
cloudcruise error-codes get <id>                      # One code by id
```

Put the returned `id` in the node param and save with `workflows update`. Saving links the code to the workflow; any other value is rejected with a 400.

Error codes are separate from the maintenance agent's error categories below.

# Error Classification

When a run fails, the maintenance agent classifies errors:

| Category           | Sub-category                 | Description                            | Recovery                  |
| ------------------ | ---------------------------- | -------------------------------------- | ------------------------- |
| **Workflow Error** | `XPATH_INCORRECT`            | Selector matches 0 or >1 elements      | Auto-patch selectors      |
|                    | `ACTION_PERFORMED_TOO_EARLY` | Clicked before element loaded          | Insert waits              |
|                    | `UNEXPECTED_POPUP`           | Modal appeared (survey, cookie banner) | Add popup handling        |
|                    | `UNEXPECTED_UI_STATE`        | Layout differs from expected           | Update graph              |
| **User Error**     | `PAGE_NOT_FOUND`             | URL returns 404                        | Notify user               |
|                    | `AUTHENTICATION_ERROR`       | Wrong/expired credentials              | Notify user               |
|                    | `INCORRECT_FORM_INPUTS`      | Invalid input data                     | Notify user               |
| **External Error** | `SERVICE_UNAVAILABLE`        | Upstream system down                   | Exponential backoff retry |
|                    | `PAGE_STILL_LOADING`         | Page stuck loading                     | Retry                     |

## Best Practices

1. **Use descriptive node names.** The maintenance agent uses them during recovery.
2. **Prefer STATIC execution** for speed and reliability. For Click and InputText, use `LLM_VISION` when a selector-driven interaction is not viable.
3. **Wait with the next node's `wait_time`**, not a Delay node (see DELAY for exceptions).
4. **Use variables** (`{{context.inputs.*}}`) instead of hardcoded values.
5. **XPath selectors should be semantic** — use @id, @name, @aria-label, @placeholder, not generated class names.
6. **For STATIC Click/InputText/InputSelect**, the selector must match exactly one element.
7. **Arrays append by default** in ExtractDatamodel. Use `overwriteArrayKeys` to replace.
8. **Loop bodies must edge back** to the loop node for iteration.
9. **For login flows**, use `clear_cookies_on_false` on the login-check BoolCondition to reset stale state.
10. **File downloads need a preceding Click** to trigger the download. The FileDownload node only captures. This does not apply when the trigger_print flag is set.
