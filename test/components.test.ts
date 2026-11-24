import { test } from "node:test"
import assert from "node:assert/strict"
import { extractComponentData } from "../dist/src/commands/components.js"

test("extractComponentData drops local_components and component_imports from a piped workflow, because they describe which components a workflow calls and not the component itself", () => {
  const workflow = {
    id: "wf_1",
    nodes: [{ id: "n1", action: "NAVIGATE", parameters: { url: "https://example.com" } }],
    edges: { n1: { to: null } },
    local_components: [{ id: "c1", name: "Login", nodes: [], edges: {} }],
    component_imports: [{ id: "c2", version: "latest" }]
  }
  const data = extractComponentData(workflow)
  assert.deepEqual(Object.keys(data).sort(), ["edges", "nodes"])
})

test("extractComponentData keeps a component's own input_schema and output_schema when unwrapping a components get response", () => {
  const response = {
    id: "c1",
    component_data: {
      nodes: [],
      edges: {},
      input_schema: { type: "object", properties: { USER: { type: "string", "x-cc-type": "credential" } } },
      output_schema: { type: "object", properties: { recipes: {} } }
    }
  }
  const data = extractComponentData(response)
  assert.deepEqual(data.input_schema, response.component_data.input_schema)
  assert.deepEqual(data.output_schema, response.component_data.output_schema)
})
