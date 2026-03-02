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

### Read-Only Fields (strip before `workflows update`)

`id`, `version_id`, `version_number`, `created_at`, `created_by`, `workspace_id`, `loginStructure`

### Mutable Fields (accepted by PUT)

**Required:** `nodes`, `edges`, `name`, `input_schema`, `output_schema`, `max_retries`

**Optional:** `description`, `version_note`, `use_native_actions`, `video_record_session`, `extract_network_urls`, `encrypted_keys`, `popup_xpaths`, `vault_schema`, `enable_popup_handling`, `enable_action_timing_recovery`, `enable_xpath_recovery`, `enable_error_code_generation`, `enable_service_unavailable_recovery`, `proxy_setting`, `proxy_value`, `enable_network_listener`

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

JSONata is especially useful in BoolCondition `comparison_value_1` for complex conditions that go beyond simple `EQUAL`/`CONTAINS` operators (see BoolCondition section below).

## Execution Types

| Type           | Description                                                                 | Used By                                                        |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `STATIC`       | Explicit XPath selectors. Fast and reliable. **Prefer this when possible.** | Click, InputText, InputSelect, BoolCondition, ExtractDatamodel |
| `LLM_VISION`   | AI decision from screenshot. Retries up to 6x with scrolling.               | Click, InputText, BoolCondition, ExtractDatamodel              |
| `LLM_DOM`      | AI extraction from HTML DOM structure.                                      | ExtractDatamodel                                               |
| `PROMPT`       | AI reasoning on context data (no screenshot).                               | ExtractDatamodel, BoolCondition                                |
| `COORDINATES`  | Click/type at specific x,y screen coordinates.                              | Click, InputText                                               |
| `COMPUTER_USE` | AI agent with computer-use capabilities.                                    | Click, InputText, TFA                                          |

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
- Selecting `<option>` directly -- always target the parent `<select>` element (use InputSelect node instead)

### Common Patterns

```
//button[@type='submit']
//input[@placeholder='Search...']
//a[@aria-label='Close']
//select[@name='country']
//input[@id='email']
//div[@role='dialog']//button[normalize-space()='Confirm']
//table[@id='results']//tbody/tr
//label[normalize-space()='Email']/following::input[1]
(//button[normalize-space()='Save'])[1]
```

### Technical Notes

- Always use `normalize-space()` instead of `text()` for visible text matching
- If the existing XPath in a workflow is already correct, do not rewrite it
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

Optional base fields: `description`, `use_native_actions`, `popup_xpaths`, `take_snapshot`

## Node Types

### START

Entry point. Every workflow has exactly one.

```json
{
  "id": "b7e9a2f1-3c4d-4a8b-9e1f-2d3c4b5a6789",
  "name": "Open site",
  "action": "START",
  "parameters": {
    "url": "https://app.example.com/login",
    "input_variables": {},
    "popup_xpaths": ["//div[@class='modal-overlay']"]
  }
}
```

| Parameter                | Type     | Required | Description                             |
| ------------------------ | -------- | -------- | --------------------------------------- |
| `url`                    | string   | Yes      | Starting URL                            |
| `input_variables`        | object   | No       | Default input values                    |
| `video_record_session`   | boolean  | No       | Record video of the run                 |
| `store_downloaded_files` | boolean  | No       | Store downloaded files                  |
| `extract_network_urls`   | string[] | No       | URL patterns to capture network traffic |
| `popup_xpaths`           | string[] | No       | XPath patterns for popup auto-dismissal |

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

| Parameter                | Type    | Required | Description                                               |
| ------------------------ | ------- | -------- | --------------------------------------------------------- |
| `execution`              | string  | Yes      | `STATIC`, `LLM_VISION`, `COORDINATES`, or `COMPUTER_USE`  |
| `selector`               | string  | No       | XPath (STATIC) or JSON `{"x":N,"y":N}` (COORDINATES)      |
| `prompt`                 | string  | No       | Natural language target description (LLM_VISION)          |
| `click_type`             | string  | No       | `click` (default), `double_click`, `right_click`, `hover` |
| `wait_time`              | number  | No       | Max ms to wait for element. Default: 15000                |
| `selector_error_message` | string  | No       | Custom error message if element not found                 |
| `human_mode`             | boolean | No       | Human-like click behavior                                 |
| `llm_model`              | string  | No       | Override LLM model                                        |

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

| Parameter            | Type    | Required | Description                                              |
| -------------------- | ------- | -------- | -------------------------------------------------------- |
| `text`               | string  | Yes      | Text to type (supports variables and JSONata)            |
| `execution`          | string  | Yes      | `STATIC`, `LLM_VISION`, `COORDINATES`, or `COMPUTER_USE` |
| `selector`           | string  | No       | XPath (STATIC) or coordinates (COORDINATES)              |
| `prompt`             | string  | No       | Natural language field description (LLM_VISION)          |
| `do_not_clear`       | boolean | No       | Append without clearing existing content                 |
| `submit_after_input` | boolean | No       | Press Enter after typing                                 |
| `aggressive_clear`   | boolean | No       | Aggressively clear field before typing                   |
| `wait_time`          | number  | No       | Max ms to wait. Default: 15000                           |
| `human_mode`         | boolean | No       | Human-like typing behavior                               |

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
| `selector`    | string  | No       | XPath to the select element                                                        |
| `fuzzy_match` | boolean | No       | Fuzzy matching for option values (e.g., "New Patient" matches "New Patient Visit") |
| `prompt`      | string  | No       | Natural language description (LLM execution)                                       |
| `wait_time`   | number  | No       | Max ms to wait. Default: 15000                                                     |

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

| Parameter            | Type    | Required    | Description                                              |
| -------------------- | ------- | ----------- | -------------------------------------------------------- |
| `extract_data_model` | object  | Yes         | JSON Schema with CloudCruise extensions (see below)      |
| `execution`          | string  | No          | `STATIC`, `LLM_DOM` (default), `LLM_VISION`, or `PROMPT` |
| `selector`           | string  | Conditional | XPath to scope extraction area. Required for `LLM_DOM`   |
| `prompt`             | string  | Conditional | Additional instructions. Required for `PROMPT` execution |
| `wait_time`          | number  | No          | Max ms to wait for selector. Default: 15000              |
| `keep_html_metadata` | boolean | No          | Preserve HTML attributes for LLM_DOM extraction          |
| `llm_model`          | string  | No          | Override LLM model                                       |

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
    "comparison_operator": "NOT_CONTAINS",
    "comparison_value_1": "{{context.current_url}}",
    "comparison_value_2": "/login"
  }
}
```

| Parameter                | Type    | Required | Description                                                |
| ------------------------ | ------- | -------- | ---------------------------------------------------------- |
| `execution`              | string  | Yes      | `STATIC`, `LLM_VISION`, or `PROMPT`                        |
| `comparison_operator`    | string  | No       | For STATIC: `EQUAL`, `NOT_EQUAL`, `IS_NULL`, `IS_NOT_NULL` |
| `comparison_value_1`     | string  | No       | First value (STATIC). Supports variables and JSONata       |
| `comparison_value_2`     | string  | No       | Second value (STATIC). Not needed for IS_NULL/IS_NOT_NULL  |
| `prompt`                 | string  | No       | Natural language condition (LLM_VISION/PROMPT)             |
| `clear_cookies_on_false` | boolean | No       | Clear cookies when false (useful for login flows)          |
| `wait_time`              | number  | No       | Max ms to wait before evaluation                           |
| `error_on_false_message` | string  | No       | Custom error code to throw when false                      |

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

Prefer using `wait_time` on action nodes over separate Delay nodes.

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

| Parameter            | Type   | Required    | Description                                      |
| -------------------- | ------ | ----------- | ------------------------------------------------ |
| `tfa_type`           | string | Yes         | `SMS`, `EMAIL`, `AUTHENTICATOR`, or `MAGIC_LINK` |
| `credential`         | string | Yes         | Vault credential key for the 2FA receiver        |
| `selector`           | string | Conditional | XPath for code input (not needed for MAGIC_LINK) |
| `execution`          | string | No          | `STATIC` (default) or `COMPUTER_USE`             |
| `link_regex_pattern` | string | No          | Regex to extract magic link from email           |

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
    "timeout_seconds": 120
  }
}
```

| Parameter                     | Type    | Required | Description                                          |
| ----------------------------- | ------- | -------- | ---------------------------------------------------- |
| `metadata`                    | object  | Yes      | Metadata attached to the download for identification |
| `selector`                    | string  | Yes      | XPath (required by DTO validation)                   |
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

| Parameter         | Type   | Required | Description                       |
| ----------------- | ------ | -------- | --------------------------------- |
| `signed_file_url` | string | Yes      | Pre-authenticated URL to the file |

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
    "timeout": 300000
  }
}
```

| Parameter            | Type   | Required | Description                                 |
| -------------------- | ------ | -------- | ------------------------------------------- |
| `expected_datamodel` | object | Yes      | JSON Schema for data to collect             |
| `server_message`     | string | No       | Message shown to user (supports variables)  |
| `timeout`            | number | No       | Max ms to wait for response. Default: 10000 |
| `error_message`      | string | No       | Custom error code on timeout                |

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

Path syntax: `$` (root), `$.field` (direct), `$.parent.child` (nested), `$[0]` (array index).

### APP_ACTION

Execute a pre-built app-specific action from the CloudCruise catalog.

```json
{
  "id": "b0c1d2e3-4567-4f89-c012-678901234567",
  "name": "LinkedIn search",
  "action": "APP_ACTION",
  "parameters": {
    "app": "linkedin.com",
    "action": "search_people",
    "context": { "query": "{{context.inputs.search_term}}" }
  }
}
```

| Parameter              | Type     | Required | Description                         |
| ---------------------- | -------- | -------- | ----------------------------------- |
| `app`                  | string   | Yes      | App domain (e.g., `linkedin.com`)   |
| `action`               | string   | Yes      | Action name from the catalog        |
| `context`              | object   | No       | Parameters for the action           |
| `extract_network_urls` | string[] | No       | Network traffic patterns to capture |

## Error Classification

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
2. **Prefer STATIC execution** for speed and reliability. Fall back to LLM_VISION when selectors are fragile.
3. **Use `wait_time` on action nodes** instead of separate Delay nodes.
4. **Use variables** (`{{context.inputs.*}}`) instead of hardcoded values.
5. **XPath selectors should be semantic** — use @id, @name, @aria-label, @placeholder, not generated class names.
6. **For STATIC Click/InputText/InputSelect**, the selector must match exactly one element.
7. **Arrays append by default** in ExtractDatamodel. Use `overwriteArrayKeys` to replace.
8. **Loop bodies must edge back** to the loop node for iteration.
9. **For login flows**, use `clear_cookies_on_false` on the login-check BoolCondition to reset stale state.
10. **File downloads need a preceding Click** to trigger the download. The FileDownload node only captures.
