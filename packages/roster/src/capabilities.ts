/** Discovery preferences, not installed tools or permission grants. */
export interface EmployeeCapability {
  name: string
  prefer: string
  fallback: string
}

export const CAPABILITIES: Record<string, EmployeeCapability> = {
  code: {
    name: "Code inspection and verification",
    prefer: "Repository search, file reads, patches, and project check commands. Load a relevant installed language or framework skill for the assigned change.",
    fallback: "Return a precise patch proposal and mark execution unverified when the runtime is unavailable.",
  },
  research: {
    name: "Source-grounded research",
    prefer: "An available documentation connector or web search and page reader. Open primary sources and retain source links, version/date, and supporting evidence.",
    fallback: "Use supplied documentation and label stale or missing evidence; never invent citations.",
  },
  browser: {
    name: "Browser and computer use",
    prefer: "A purpose-built API or existing browser automation first. Discover the host's computer-use tools and read their instructions. An optional Playwright MCP server provides browser automation across MCP-capable hosts; it does not provide native desktop control.",
    fallback: "Use project browser tests or return a reproducible manual procedure and mark live interaction unverified. A tool from another host is not callable merely because its name is known.",
  },
  design: {
    name: "Design references and visual assets",
    prefer: "Supplied design files, an available design connector such as Figma, and installed interface-design skills. Use image generation only when a raster asset is part of the task.",
    fallback: "Work from repository components and supplied references; record unavailable source-design details.",
  },
  data: {
    name: "Data analysis",
    prefer: "The authorized data connector, SQL client, or local analysis runtime. Use spreadsheet skills for workbook artifacts. Start with bounded read queries and record provenance.",
    fallback: "Use a supplied extract or clearly labeled synthetic fixture; do not claim results about inaccessible production data.",
  },
  operations: {
    name: "Operations and delivery",
    prefer: "Available CI, logs, metrics, cloud connectors, and project deployment tooling. Inspect the target environment and current context before actions.",
    fallback: "Prepare configuration and a validation procedure with the exact missing access. Distinguish a dry run from deployment.",
  },
  security: {
    name: "Security evidence",
    prefer: "Source inspection, configured scanners, and authorized security tools. Verify scanner findings against the actual dependency and execution path.",
    fallback: "Perform a bounded source review and report its coverage limits; missing scanning is not evidence of safety.",
  },
  documents: {
    name: "Documents and planning artifacts",
    prefer: "Repository Markdown for local work; an installed document, spreadsheet, or presentation skill when that format is requested. Use connected work trackers within the authorized scope.",
    fallback: "Deliver a local artifact in an available format and identify requested external publication that remains undone.",
  },
  hardware: {
    name: "Electrical design and measurement",
    prefer: "Manufacturer datasheets and available EDA, simulation, serial, or lab tooling. Record units, revisions, operating limits, and instrument setup.",
    fallback: "Provide calculations and a bench procedure; label physical checks not run when equipment is unavailable.",
  },
}
