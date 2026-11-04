const c = (n: number) => String.fromCharCode(n);

/** Small exports in the shapes ChatGPT, Claude and Google Takeout use, for tests. */

export const chatgpt = [
  {
    title: "Boiler pressure",
    create_time: 1717236000.5,
    update_time: 1717236300.25,
    conversation_id: "6650a1b2-0000-4000-8000-000000000001",
    default_model_slug: "gpt-4o",
    current_node: "a2",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["sys"] },
      sys: {
        id: "sys",
        message: { author: { role: "system" }, content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } },
        parent: "root",
        children: ["u1"],
      },
      u1: {
        id: "u1",
        message: { author: { role: "user" }, create_time: 1717236001, content: { content_type: "text", parts: ["My boiler shows 0.5 bar. Is that low?"] }, metadata: {} },
        parent: "sys",
        children: ["a1old", "a1"],
      },
      a1old: {
        id: "a1old",
        message: { author: { role: "assistant" }, create_time: 1717236002, content: { content_type: "text", parts: ["An abandoned branch."] }, metadata: { model_slug: "gpt-4o" } },
        parent: "u1",
        children: [],
      },
      a1: {
        id: "a1",
        message: {
          author: { role: "assistant" },
          create_time: 1717236003,
          recipient: "python",
          content: { content_type: "code", text: "print(1)" },
          metadata: { model_slug: "gpt-4o" },
        },
        parent: "u1",
        children: ["t1"],
      },
      t1: {
        id: "t1",
        message: { author: { role: "tool", name: "python" }, create_time: 1717236004, content: { content_type: "execution_output", text: "1" }, metadata: {} },
        parent: "a1",
        children: ["a2a"],
      },
      a2a: {
        id: "a2a",
        message: {
          author: { role: "assistant" },
          create_time: 1717236005,
          recipient: "all",
          content: { content_type: "text", parts: [`Yes, 0.5 bar is low ${c(0xe200)}cite${c(0xe202)}turn0search0${c(0xe201)}.`] },
          metadata: { model_slug: "gpt-4o" },
        },
        parent: "t1",
        children: ["a2"],
      },
      a2: {
        id: "a2",
        message: {
          author: { role: "assistant" },
          create_time: 1717236006,
          content: { content_type: "text", parts: [`Top it up to about 1.5 bar${c(0x3010)}3${c(0x2020)}source${c(0x3011)}.`] },
          metadata: { model_slug: "gpt-4o" },
        },
        parent: "a2a",
        children: [],
      },
    },
  },
  {
    title: "Photo question",
    create_time: 1720000000,
    update_time: 1720000100,
    id: "6650a1b2-0000-4000-8000-000000000002",
    mapping: {
      x: { id: "x", message: null, parent: null, children: ["y"] },
      y: {
        id: "y",
        message: {
          author: { role: "user" },
          create_time: 1720000001,
          content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://abc" }, "What plant is this?"] },
          metadata: {},
        },
        parent: "x",
        children: ["z"],
      },
      z: {
        id: "z",
        message: { author: { role: "assistant" }, create_time: null, content: { content_type: "text", parts: ["A monstera."] }, metadata: {} },
        parent: "y",
        children: [],
      },
    },
  },
  { title: "Empty", create_time: 1720000000, update_time: 1720000000, id: "empty", current_node: "e", mapping: { e: { id: "e", message: null, parent: null, children: [] } } },
];

export const claude = [
  {
    uuid: "c0ffee00-0000-4000-8000-000000000001",
    name: "Trip to Lahore",
    created_at: "2025-03-01T10:00:00.000000Z",
    updated_at: "2025-03-01T10:05:00.000000Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        text: "Plan a 3 day trip to Lahore.",
        content: [{ type: "text", text: "Plan a 3 day trip to Lahore." }],
        created_at: "2025-03-01T10:00:01.000000Z",
        attachments: [{ file_name: "flights.pdf", extracted_content: "secret pdf text" }],
        files: [],
      },
      {
        uuid: "m2",
        sender: "assistant",
        text: "",
        content: [
          { type: "thinking", thinking: "hidden thoughts" },
          { type: "text", text: "Day 1: Badshahi Mosque." },
          { type: "tool_use", name: "web_search", input: {} },
          { type: "text", text: "Day 2: Food Street." },
        ],
        created_at: "2025-03-01T10:00:20.000000Z",
      },
    ],
  },
  { uuid: "no-messages", name: "Nothing", created_at: "2025-03-02T10:00:00Z", updated_at: "2025-03-02T10:00:00Z", chat_messages: [] },
];

export const gemini = [
  {
    header: "Gemini Apps",
    title: "Prompted what is the capital of Pakistan",
    time: "2025-05-01T09:00:00.000Z",
    products: ["Gemini Apps"],
    safeHtmlItem: [{ html: "<p>The capital is <b>Islamabad</b>.</p><ul><li>Pop: 1.2m</li></ul><script>alert(1)</script>" }],
  },
  {
    header: "Gemini Apps",
    title: "Prompted and its population?",
    time: "2025-05-01T09:10:00.000Z",
    safeHtmlItem: [{ html: "<p>About 1.2 million &amp; growing.</p>" }],
  },
  { header: "Gemini Apps", title: "Used an Assistant feature", time: "2025-05-01T09:11:00.000Z" },
  {
    header: "Gemini Apps",
    title: "Prompted write a haiku",
    time: "2025-05-03T18:00:00.000Z",
    safeHtmlItem: [{ html: "<p>Old pond<br>frog jumps in</p>" }],
  },
];
